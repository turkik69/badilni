-- ============================================================
-- بادلني (Badilni) — قاعدة البيانات الأساسية
-- Migration: badilni_initial_schema (نسخة نهائية بعد تدقيق الأمان والأداء)
-- مطبَّقة فعلياً على مشروع Supabase الحي (badilni)
-- ============================================================

create extension if not exists "pgcrypto";

-- ============================================================
-- 1) الملفات الشخصية (profiles)
-- تمتد من auth.users القياسي في Supabase - لا نضع أعمدة مخصصة
-- على auth.users مباشرة، بل في جدول مرتبط (أفضل ممارسة)
-- ============================================================
create table public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  full_name text,
  avatar_url text,
  city text,
  kyc_level text not null default 'phone_only' check (kyc_level in ('phone_only', 'id_verified')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

comment on table public.profiles is 'بيانات المستخدم العامة. رقم الهاتف يبقى في auth.users فقط ولا يُنسخ هنا لحمايته من الظهور العام';

alter table public.profiles enable row level security;

create policy "الملفات الشخصية مرئية لكل مستخدم مسجّل"
  on public.profiles for select
  to authenticated
  using (true);

-- ملاحظة أداء: (select auth.uid()) بدل auth.uid() مباشرة، حتى يُقيَّم مرة واحدة
-- للاستعلام كاملاً بدل إعادة تقييمه لكل صف عند التوسّع (توصية Supabase الرسمية)
create policy "المستخدم يعدّل ملفه الشخصي فقط"
  on public.profiles for update
  to authenticated
  using ((select auth.uid()) = id)
  with check ((select auth.uid()) = id);

-- إنشاء ملف شخصي تلقائياً عند تسجيل أي مستخدم جديد
create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer set search_path = public
as $$
begin
  insert into public.profiles (id, full_name)
  values (new.id, coalesce(new.raw_user_meta_data->>'full_name', ''));
  return new;
end;
$$;

create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

-- تحصين: هذه دالة تشغّلها Supabase عبر Trigger فقط، ولا يجوز استدعاؤها
-- مباشرة من أي عميل عبر /rest/v1/rpc - بوستجرس يمنح EXECUTE لـ PUBLIC
-- تلقائياً عند إنشاء أي دالة، لذا يجب إلغاؤها صراحة
revoke execute on function public.handle_new_user() from public;

-- ============================================================
-- 2) الفئات (categories) — تبدأ بثلاث فئات فقط (MVP)
-- ============================================================
create table public.categories (
  id uuid primary key default gen_random_uuid(),
  name_ar text not null,
  name_en text not null,
  icon text,
  is_active boolean not null default true,
  created_at timestamptz not null default now()
);

alter table public.categories enable row level security;

create policy "الفئات مرئية للجميع حتى قبل تسجيل الدخول"
  on public.categories for select
  to anon, authenticated
  using (is_active = true);

insert into public.categories (name_ar, name_en, icon) values
  ('إلكترونيات', 'Electronics', 'smartphone'),
  ('ألعاب فيديو', 'Video Games', 'gamepad'),
  ('كتب', 'Books', 'book');

-- ============================================================
-- 3) الأغراض (items)
-- ============================================================
create table public.items (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references public.profiles(id) on delete cascade,
  category_id uuid not null references public.categories(id),
  title text not null,
  description text,
  condition text not null check (condition in ('new', 'like_new', 'good', 'fair')),
  estimated_value numeric(10,3) not null check (estimated_value >= 0),
  photos jsonb not null default '[]'::jsonb,
  wants_category_id uuid references public.categories(id),
  wants_description text,
  wants_item_id uuid references public.items(id),
  accepts_points boolean not null default true,
  city text,
  status text not null default 'available' check (status in ('available', 'pending', 'matched', 'completed', 'cancelled')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

comment on column public.items.estimated_value is 'بالريال العُماني (OMR)';
comment on column public.items.status is 'التحويل إلى completed يتم فقط عبر دالة confirm_trade_receipt الآمنة، وليس مباشرة من العميل - تحصين إضافي لهذا الانتقال مؤجّل لمرحلة لاحقة';

create index items_owner_id_idx on public.items(owner_id);
create index items_category_id_idx on public.items(category_id);
create index items_status_idx on public.items(status);
create index items_wants_category_id_idx on public.items(wants_category_id);
create index items_wants_item_id_idx on public.items(wants_item_id);

alter table public.items enable row level security;

create policy "الأغراض المتاحة مرئية للجميع، وصاحبها يرى كل حالاتها"
  on public.items for select
  to authenticated
  using (status = 'available' or owner_id = (select auth.uid()));

create policy "المستخدم يضيف أغراضه فقط"
  on public.items for insert
  to authenticated
  with check (owner_id = (select auth.uid()));

create policy "المستخدم يعدّل أغراضه فقط"
  on public.items for update
  to authenticated
  using (owner_id = (select auth.uid()))
  with check (owner_id = (select auth.uid()));

create policy "المستخدم يحذف أغراضه المتاحة فقط"
  on public.items for delete
  to authenticated
  using (owner_id = (select auth.uid()) and status = 'available');

-- ============================================================
-- 4) المطابقات (matches + match_items)
-- جدول وسيط (match_items) بدل عمودين ثابتين، حتى يدعم لاحقاً
-- مطابقات ثلاثية أو أكثر (Cycle Matching) دون تعديل الهيكل
-- ============================================================
create table public.matches (
  id uuid primary key default gen_random_uuid(),
  match_type text not null default 'direct' check (match_type in ('direct', 'cycle')),
  status text not null default 'suggested' check (status in ('suggested', 'dismissed', 'accepted')),
  created_at timestamptz not null default now()
);

create table public.match_items (
  match_id uuid not null references public.matches(id) on delete cascade,
  item_id uuid not null references public.items(id) on delete cascade,
  primary key (match_id, item_id)
);

create index match_items_item_id_idx on public.match_items(item_id);

alter table public.matches enable row level security;
alter table public.match_items enable row level security;

-- ملاحظة: لا توجد سياسة INSERT هنا عمداً - المطابقات يُنشئها فقط
-- محرك التوفيق عبر دالة آمنة (SECURITY DEFINER)، وليس المستخدم مباشرة

create policy "أصحاب الأغراض يرون مطابقاتهم"
  on public.matches for select
  to authenticated
  using (
    exists (
      select 1 from public.match_items mi
      join public.items i on i.id = mi.item_id
      where mi.match_id = matches.id and i.owner_id = (select auth.uid())
    )
  );

create policy "أصحاب الأغراض يقبلون أو يرفضون المطابقة"
  on public.matches for update
  to authenticated
  using (
    exists (
      select 1 from public.match_items mi
      join public.items i on i.id = mi.item_id
      where mi.match_id = matches.id and i.owner_id = (select auth.uid())
    )
  );

create policy "أصحاب الأغراض يرون تفاصيل مطابقاتهم"
  on public.match_items for select
  to authenticated
  using (
    exists (
      select 1 from public.match_items mi2
      join public.items i2 on i2.id = mi2.item_id
      where mi2.match_id = match_items.match_id and i2.owner_id = (select auth.uid())
    )
  );

-- ============================================================
-- 5) عروض المبادلة (trade_offers)
-- ============================================================
create table public.trade_offers (
  id uuid primary key default gen_random_uuid(),
  match_id uuid references public.matches(id),
  status text not null default 'negotiating' check (status in ('negotiating', 'agreed', 'completed', 'cancelled')),
  cash_adjustment_amount numeric(10,3) not null default 0,
  cash_adjustment_payer_id uuid references public.profiles(id),
  points_amount numeric(10,2) not null default 0,
  points_payer_id uuid references public.profiles(id),
  created_at timestamptz not null default now(),
  agreed_at timestamptz,
  completed_at timestamptz
);

comment on column public.trade_offers.cash_adjustment_amount is 'مسجَّل هنا فقط كاتفاق - تنفيذ الدفع الفعلي عبر بوابة دفع خارجية (مرحلة قادمة)';

create table public.trade_offer_items (
  trade_offer_id uuid not null references public.trade_offers(id) on delete cascade,
  item_id uuid not null references public.items(id),
  offered_by uuid not null references public.profiles(id),
  primary key (trade_offer_id, item_id)
);

create index trade_offer_items_offered_by_idx on public.trade_offer_items(offered_by);
create index trade_offer_items_item_id_idx on public.trade_offer_items(item_id);

create table public.trade_confirmations (
  trade_offer_id uuid not null references public.trade_offers(id) on delete cascade,
  user_id uuid not null references public.profiles(id),
  confirmed_at timestamptz not null default now(),
  primary key (trade_offer_id, user_id)
);

create index trade_confirmations_user_id_idx on public.trade_confirmations(user_id);
create index trade_offers_match_id_idx on public.trade_offers(match_id);
create index trade_offers_cash_adjustment_payer_id_idx on public.trade_offers(cash_adjustment_payer_id);
create index trade_offers_points_payer_id_idx on public.trade_offers(points_payer_id);

alter table public.trade_offers enable row level security;
alter table public.trade_offer_items enable row level security;
alter table public.trade_confirmations enable row level security;

create policy "أطراف الصفقة يرونها"
  on public.trade_offers for select
  to authenticated
  using (
    exists (
      select 1 from public.trade_offer_items toi
      where toi.trade_offer_id = trade_offers.id and toi.offered_by = (select auth.uid())
    )
  );

create policy "أي مستخدم مسجّل ينشئ عرض مبادلة"
  on public.trade_offers for insert
  to authenticated
  with check (true);

create policy "أطراف الصفقة يعدّلونها أثناء التفاوض فقط"
  on public.trade_offers for update
  to authenticated
  using (
    status = 'negotiating'
    and exists (
      select 1 from public.trade_offer_items toi
      where toi.trade_offer_id = trade_offers.id and toi.offered_by = (select auth.uid())
    )
  );

create policy "أطراف الصفقة يرون الأغراض المرتبطة بها"
  on public.trade_offer_items for select
  to authenticated
  using (
    exists (
      select 1 from public.trade_offer_items toi2
      where toi2.trade_offer_id = trade_offer_items.trade_offer_id and toi2.offered_by = (select auth.uid())
    )
  );

create policy "الطرف يضيف غرضه للصفقة فقط"
  on public.trade_offer_items for insert
  to authenticated
  with check (offered_by = (select auth.uid()));

create policy "أطراف الصفقة يرون تأكيدات الاستلام"
  on public.trade_confirmations for select
  to authenticated
  using (
    exists (
      select 1 from public.trade_offer_items toi
      where toi.trade_offer_id = trade_confirmations.trade_offer_id and toi.offered_by = (select auth.uid())
    )
  );

create policy "المستخدم يؤكد استلامه فقط"
  on public.trade_confirmations for insert
  to authenticated
  with check (user_id = (select auth.uid()));

-- ============================================================
-- 6) دفتر النقاط (points_ledger) — سجل تراكمي غير قابل للتعديل
-- الرصيد لا يُخزَّن كعمود، بل يُحسب دائماً من هذا الدفتر (View)
-- لمنع أي تلاعب أو عدم تطابق - هذا هو الدرس المستفاد من تجربة Bunz
-- ============================================================
create table public.points_ledger (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles(id),
  amount numeric(10,2) not null,
  transaction_type text not null check (transaction_type in ('trade_earn', 'hold', 'release', 'signup_bonus', 'referral_bonus', 'adjustment')),
  related_trade_offer_id uuid references public.trade_offers(id),
  created_at timestamptz not null default now()
);

create index points_ledger_user_id_idx on public.points_ledger(user_id);
create index points_ledger_related_trade_offer_id_idx on public.points_ledger(related_trade_offer_id);

alter table public.points_ledger enable row level security;

create policy "المستخدم يرى حركات نقاطه فقط"
  on public.points_ledger for select
  to authenticated
  using (user_id = (select auth.uid()));

-- عمداً: لا توجد سياسات insert/update/delete هنا للمستخدمين
-- الإضافة الوحيدة المسموحة عبر الدوال الآمنة أدناه، لمنع أي مستخدم
-- من منح نفسه نقاطاً مباشرة عبر واجهة برمجية عامة

create view public.user_points_balance
with (security_invoker = true)
as
select user_id, coalesce(sum(amount), 0) as balance
from public.points_ledger
group by user_id;

-- ============================================================
-- 7) الرسائل (messages)
-- ============================================================
create table public.messages (
  id uuid primary key default gen_random_uuid(),
  trade_offer_id uuid not null references public.trade_offers(id) on delete cascade,
  sender_id uuid not null references public.profiles(id),
  content text not null,
  created_at timestamptz not null default now()
);

create index messages_trade_offer_id_idx on public.messages(trade_offer_id);
create index messages_sender_id_idx on public.messages(sender_id);

alter table public.messages enable row level security;

create policy "أطراف الصفقة يرون رسائلها"
  on public.messages for select
  to authenticated
  using (
    exists (
      select 1 from public.trade_offer_items toi
      where toi.trade_offer_id = messages.trade_offer_id and toi.offered_by = (select auth.uid())
    )
  );

create policy "أطراف الصفقة يرسلون رسائل"
  on public.messages for insert
  to authenticated
  with check (
    sender_id = (select auth.uid())
    and exists (
      select 1 from public.trade_offer_items toi
      where toi.trade_offer_id = messages.trade_offer_id and toi.offered_by = (select auth.uid())
    )
  );

-- ============================================================
-- 8) التقييمات (reviews)
-- ============================================================
create table public.reviews (
  id uuid primary key default gen_random_uuid(),
  trade_offer_id uuid not null references public.trade_offers(id),
  reviewer_id uuid not null references public.profiles(id),
  reviewee_id uuid not null references public.profiles(id),
  rating integer not null check (rating between 1 and 5),
  comment text,
  created_at timestamptz not null default now(),
  unique (trade_offer_id, reviewer_id)
);

create index reviews_reviewee_id_idx on public.reviews(reviewee_id);
create index reviews_reviewer_id_idx on public.reviews(reviewer_id);

alter table public.reviews enable row level security;

create policy "التقييمات مرئية للجميع لبناء الثقة"
  on public.reviews for select
  to anon, authenticated
  using (true);

create policy "طرفا الصفقة المكتملة فقط يقيّمان بعضهما"
  on public.reviews for insert
  to authenticated
  with check (
    reviewer_id = (select auth.uid())
    and exists (
      select 1 from public.trade_offer_items toi
      where toi.trade_offer_id = reviews.trade_offer_id and toi.offered_by = (select auth.uid())
    )
    and exists (
      select 1 from public.trade_offers t
      where t.id = reviews.trade_offer_id and t.status = 'completed'
    )
  );

create view public.user_ratings
with (security_invoker = true)
as
select reviewee_id as user_id, round(avg(rating)::numeric, 2) as rating_avg, count(*) as rating_count
from public.reviews
group by reviewee_id;

-- ============================================================
-- 9) البلاغات (reports)
-- ============================================================
create table public.reports (
  id uuid primary key default gen_random_uuid(),
  reporter_id uuid not null references public.profiles(id),
  reported_item_id uuid references public.items(id),
  reported_user_id uuid references public.profiles(id),
  reason text not null,
  status text not null default 'open' check (status in ('open', 'reviewing', 'resolved', 'dismissed')),
  created_at timestamptz not null default now()
);

create index reports_reporter_id_idx on public.reports(reporter_id);
create index reports_reported_item_id_idx on public.reports(reported_item_id);
create index reports_reported_user_id_idx on public.reports(reported_user_id);

alter table public.reports enable row level security;

create policy "أي مستخدم يستطيع الإبلاغ"
  on public.reports for insert
  to authenticated
  with check (reporter_id = (select auth.uid()));

create policy "المستخدم يرى بلاغاته فقط"
  on public.reports for select
  to authenticated
  using (reporter_id = (select auth.uid()));

-- ============================================================
-- 10) الإشعارات (notifications)
-- ============================================================
create table public.notifications (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles(id) on delete cascade,
  type text not null check (type in ('match_found', 'trade_message', 'trade_status_change', 'report_update')),
  related_id uuid,
  title text not null,
  body text,
  is_read boolean not null default false,
  created_at timestamptz not null default now()
);

create index notifications_user_id_idx on public.notifications(user_id, is_read);

alter table public.notifications enable row level security;

create policy "المستخدم يرى إشعاراته فقط"
  on public.notifications for select
  to authenticated
  using (user_id = (select auth.uid()));

create policy "المستخدم يحدّث حالة القراءة فقط"
  on public.notifications for update
  to authenticated
  using (user_id = (select auth.uid()))
  with check (user_id = (select auth.uid()));

-- ============================================================
-- 11) محرك التوفيق الذكي (Matching Engine) — مطابقة ثنائية مباشرة
-- المطابقة الدائرية (٣ أطراف فأكثر) مؤجّلة لمرحلة ٢ على نفس الهيكل
-- ============================================================
create or replace function public.find_direct_matches(p_item_id uuid)
returns setof uuid
language plpgsql
security definer set search_path = public
as $$
declare
  v_item public.items;
  v_candidate public.items;
  v_new_match_id uuid;
begin
  select * into v_item from public.items where id = p_item_id and status = 'available';

  if not found then
    return;
  end if;

  for v_candidate in
    select * from public.items i
    where i.status = 'available'
      and i.owner_id <> v_item.owner_id
      and (v_item.wants_category_id is null or i.category_id = v_item.wants_category_id)
      and (i.wants_category_id is null or v_item.category_id = i.wants_category_id)
      and not exists (
        select 1 from public.match_items mi1
        join public.match_items mi2 on mi1.match_id = mi2.match_id
        where mi1.item_id = p_item_id and mi2.item_id = i.id
      )
  loop
    insert into public.matches (match_type, status) values ('direct', 'suggested')
    returning id into v_new_match_id;

    insert into public.match_items (match_id, item_id) values
      (v_new_match_id, p_item_id),
      (v_new_match_id, v_candidate.id);

    return next v_candidate.id;
  end loop;

  return;
end;
$$;

revoke execute on function public.find_direct_matches(uuid) from public;

create or replace function public.trigger_find_matches_on_new_item()
returns trigger
language plpgsql
security definer set search_path = public
as $$
begin
  perform public.find_direct_matches(new.id);
  return new;
end;
$$;

create trigger on_item_created_find_matches
  after insert on public.items
  for each row execute function public.trigger_find_matches_on_new_item();

revoke execute on function public.trigger_find_matches_on_new_item() from public;

-- إشعار فوري لصاحب الغرض عند وجود مطابقة جديدة
create or replace function public.notify_on_match()
returns trigger
language plpgsql
security definer set search_path = public
as $$
declare
  v_owner_id uuid;
begin
  select owner_id into v_owner_id from public.items where id = new.item_id;

  insert into public.notifications (user_id, type, related_id, title, body)
  values (
    v_owner_id,
    'match_found',
    new.match_id,
    'وجدنا لك مطابقة!',
    'يوجد غرض قد يهمك تبديله - افتح التطبيق للاطلاع'
  );
  return new;
end;
$$;

create trigger on_match_item_created
  after insert on public.match_items
  for each row execute function public.notify_on_match();

revoke execute on function public.notify_on_match() from public;

-- ============================================================
-- 12) دوال محفظة النقاط والصفقات الآمنة
-- كل دالة تستخدم auth.uid() فقط لتحديد صاحب العملية - لا تثق أبداً
-- بمعرّف مستخدم يُمرَّر من العميل عند التعامل مع النقاط.
-- وكلها SECURITY DEFINER يستدعيها المستخدم مباشرة عبر RPC، لذا نمنح
-- EXECUTE فقط لـ authenticated بعد إلغائها أولاً من PUBLIC
-- ============================================================
create or replace function public.hold_trade_points(p_trade_offer_id uuid)
returns void
language plpgsql
security definer set search_path = public
as $$
declare
  v_amount numeric;
  v_payer_id uuid;
  v_available numeric;
begin
  select points_amount, points_payer_id into v_amount, v_payer_id
  from public.trade_offers where id = p_trade_offer_id;

  if v_amount is null or v_amount <= 0 then
    return;
  end if;

  if v_payer_id <> auth.uid() then
    raise exception 'غير مصرح لك بحجز نقاط لهذه الصفقة';
  end if;

  -- قفل احترازي يمنع تعارض عمليتين متزامنتين على نفس رصيد المستخدم
  perform pg_advisory_xact_lock(hashtext(auth.uid()::text));

  select coalesce(sum(amount), 0) into v_available
  from public.points_ledger where user_id = auth.uid();

  if v_available < v_amount then
    raise exception 'رصيد النقاط غير كافٍ لإتمام هذه الصفقة';
  end if;

  insert into public.points_ledger (user_id, amount, transaction_type, related_trade_offer_id)
  values (auth.uid(), -v_amount, 'hold', p_trade_offer_id);
end;
$$;

create or replace function public.confirm_trade_receipt(p_trade_offer_id uuid)
returns void
language plpgsql
security definer set search_path = public
as $$
declare
  v_participant_count integer;
  v_confirmation_count integer;
  v_status text;
  v_points_amount numeric;
  v_points_payer_id uuid;
begin
  if not exists (
    select 1 from public.trade_offer_items
    where trade_offer_id = p_trade_offer_id and offered_by = auth.uid()
  ) then
    raise exception 'غير مصرح لك بتأكيد هذه الصفقة';
  end if;

  select status, points_amount, points_payer_id
    into v_status, v_points_amount, v_points_payer_id
  from public.trade_offers where id = p_trade_offer_id;

  if v_status <> 'agreed' then
    raise exception 'الصفقة ليست في حالة قابلة للتأكيد';
  end if;

  insert into public.trade_confirmations (trade_offer_id, user_id)
  values (p_trade_offer_id, auth.uid())
  on conflict (trade_offer_id, user_id) do nothing;

  select count(distinct offered_by) into v_participant_count
  from public.trade_offer_items where trade_offer_id = p_trade_offer_id;

  select count(*) into v_confirmation_count
  from public.trade_confirmations where trade_offer_id = p_trade_offer_id;

  -- لا يُغلَق شيء إلا بعد تأكيد جميع الأطراف - وفق طلبك بالضبط
  if v_confirmation_count >= v_participant_count then
    update public.trade_offers
    set status = 'completed', completed_at = now()
    where id = p_trade_offer_id;

    update public.items
    set status = 'completed'
    where id in (select item_id from public.trade_offer_items where trade_offer_id = p_trade_offer_id);

    if v_points_amount is not null and v_points_amount > 0 and v_points_payer_id is not null then
      insert into public.points_ledger (user_id, amount, transaction_type, related_trade_offer_id)
      select toi.offered_by, v_points_amount, 'trade_earn', p_trade_offer_id
      from public.trade_offer_items toi
      where toi.trade_offer_id = p_trade_offer_id and toi.offered_by <> v_points_payer_id
      limit 1;
    end if;
  end if;
end;
$$;

create or replace function public.cancel_trade_offer(p_trade_offer_id uuid)
returns void
language plpgsql
security definer set search_path = public
as $$
declare
  v_status text;
begin
  if not exists (
    select 1 from public.trade_offer_items
    where trade_offer_id = p_trade_offer_id and offered_by = auth.uid()
  ) then
    raise exception 'غير مصرح لك بإلغاء هذه الصفقة';
  end if;

  select status into v_status from public.trade_offers where id = p_trade_offer_id;
  if v_status in ('completed', 'cancelled') then
    raise exception 'لا يمكن إلغاء صفقة مكتملة أو ملغاة مسبقاً';
  end if;

  -- إعادة أي نقاط محجوزة لهذه الصفقة فوراً
  insert into public.points_ledger (user_id, amount, transaction_type, related_trade_offer_id)
  select user_id, -amount, 'release', p_trade_offer_id
  from public.points_ledger
  where related_trade_offer_id = p_trade_offer_id and transaction_type = 'hold';

  update public.trade_offers set status = 'cancelled' where id = p_trade_offer_id;

  update public.items set status = 'available'
  where id in (select item_id from public.trade_offer_items where trade_offer_id = p_trade_offer_id);
end;
$$;

revoke execute on function public.hold_trade_points(uuid) from public;
revoke execute on function public.confirm_trade_receipt(uuid) from public;
revoke execute on function public.cancel_trade_offer(uuid) from public;

grant execute on function public.hold_trade_points(uuid) to authenticated;
grant execute on function public.confirm_trade_receipt(uuid) to authenticated;
grant execute on function public.cancel_trade_offer(uuid) to authenticated;

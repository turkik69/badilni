const assert = require('assert');
const fs = require('fs');
const vm = require('vm');

const html = fs.readFileSync(`${__dirname}/../index.html`, 'utf8');
const section = (start, end) => html.slice(html.indexOf(start), html.indexOf(end, html.indexOf(start)));
const inputs = new Map();
const warnings = [];
let submitted;
const state = {
  session: { user: { id: 'owner' } }, selectedCat: null, addStep: 0, scrollPositions: {},
  addDraft: { title: '', description: '', condition: 'good', wantsCategory: '', wantsDescription: '', acceptsPoints: true, details: {} },
  categories: [{ id: 'books', icon: 'book', name_ar: 'كتب' }], newPhotoUrl: null, editingItemId: null, uploading: false
};
const context = {
  state, document: { getElementById: id => id === 'add-form' ? {} : inputs.get(id) },
  CATEGORY_SUBTYPES: { books: ['روايات'] }, CAT_EMOJI: { book: '📚' }, COND_LABEL: { good: 'جيد' },
  alert: message => warnings.push(message), render: () => {},
  sb: { from: () => ({ insert: payload => { submitted = payload; return Promise.resolve({ error: null }); } }) },
  goTo: async () => {},
  escapeHtml: value => String(value ?? ''), icon: () => '', categoryArtwork: () => '', categoryMark: () => '',
  catName: id => id === 'books' ? 'كتب' : '', typeSummary: item => item.item_details?.subtype || '', safeImageUrl: url => url || ''
};
vm.createContext(context);
vm.runInContext(section('function syncAddDraft()', 'function selectCat(')
  + section('function goAddStep(', 'async function handleQuickOfferItem(')
  + section('function renderAddForm()', 'function renderMine('), context);

(async () => {
  context.goAddStep(1);
  assert.strictEqual(state.addStep, 0, 'category must be selected first');
  state.selectedCat = 'books'; context.goAddStep(1);
  assert.strictEqual(state.addStep, 1);
  inputs.set('f-title', { value: 'رواية بحالة جيدة' });
  inputs.set('f-desc', { value: 'نسخة نظيفة' });
  inputs.set('f-cond', { value: 'good' });
  inputs.set('f-subtype', { value: 'روايات' });
  context.goAddStep(2);
  assert.strictEqual(state.addStep, 2);
  for (const key of ['f-title', 'f-desc', 'f-cond', 'f-subtype']) inputs.delete(key);
  inputs.set('f-wants-cat', { value: '' });
  inputs.set('f-wants-desc', { value: 'أي لعبة مناسبة' });
  inputs.set('f-points', { checked: false });
  context.goAddStep(3);
  assert(context.renderAddForm().includes('رواية بحالة جيدة'), 'final step must preview the item');
  assert(context.renderAddForm().includes('أي لعبة مناسبة'), 'final step must preview the wanted item');
  await context.handleAddItem({ preventDefault() {} });
  assert.strictEqual(submitted.title, 'رواية بحالة جيدة');
  assert.strictEqual(submitted.item_details.subtype, 'روايات');
  assert.strictEqual(submitted.wants_description, 'أي لعبة مناسبة');
  assert.strictEqual(submitted.accepts_points, false);
  assert(!('price' in submitted), 'barter listing must not contain a price');
  assert.strictEqual(state.addStep, 0, 'successful publication resets the wizard');
  console.log('✓ listing wizard preserves fields, previews the offer, and publishes barter data');
})().catch(error => { console.error(error); process.exit(1); });

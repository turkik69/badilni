const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

const html = fs.readFileSync(new URL('../index.html', `file://${__filename}`), 'utf8');
const start = html.indexOf('function syncAddDraft(){');
const end = html.indexOf('async function handleAddItem(', start);
assert(start !== -1 && end > start, 'listing form handlers exist');

const fields = {
  'add-form': {}, 'f-title': {value:'سيارة للمبادلة'}, 'f-desc': {value:''},
  'f-cond': {value:'good'}, 'f-wants-cat': {value:''}, 'f-wants-desc': {value:''},
  'f-points': {checked:true}, 'f-subtype': {value:'سيارات'},
  'f-model': {value:'كامري'}, 'f-year': {value:'2022'}
};
const state = {selectedCat:'vehicles', addDraft:{details:{}}};
const context = {state, document:{getElementById:id=>fields[id]||null}, render:()=>{}};
vm.createContext(context);
vm.runInContext(html.slice(start,end), context);

context.selectCarMake('toyota');
context.syncAddDraft(); // Typing a model or year triggers another draft sync.
assert.equal(state.addDraft.details.make, 'toyota', 'selected logo survives subsequent edits');
assert.equal(state.addDraft.details.model, 'كامري');
assert.equal(state.addDraft.details.year, '2022');

context.selectCat('electronics');
assert.equal(state.addDraft.details.make, undefined, 'changing categories clears the vehicle make');
console.log('✓ vehicle make selection persists through form edits');

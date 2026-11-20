import {createReviewWorkflow} from './review-workflow.js';

const $ = (id) => document.getElementById(id);
const readOnly = document.body.hasAttribute('data-read-only');
const names = {shots:'Shots', people:'People', text_on_screen:'On-screen text', objects_logos:'Objects / logos', dialogue:'Dialogue'};
const fieldNames = {label:'Label', detail:'Description', camera:'Camera', transition:'Transition in',
  audio:'Music and effects', speaker:'Speaker', importance:'Importance', visual_query:'Detection phrase', kind:'Type',
  composition:'Frame composition', motion:'Movement and direction', palette:'Color and lighting', placement:'On-screen placement'};
const types = ['person', 'object', 'logo', 'animal'];
let datasets = [], dataset, clips = [], fields = {}, enabledModels = {}, clip, state, suggestions, prompt;
let autolabel, autolabelPoll;
const mainContent = $('main-content');
const viewer = document.querySelector('.viewer');
const clipCountFormat = new Intl.NumberFormat();
const datasetNav = $('dataset-nav');
const confirmDialog = $('review-confirm');
let pickerCount = 0;
let activePicker;
const workflowModes = ['labeling', 'generation', 'evaluation'];
const initialParams = new URLSearchParams(window.location.search);
let workflowMode = workflowModes.includes(initialParams.get('view')) ? initialParams.get('view') : 'labeling';
let evaluationSection = initialParams.get('section') === 'overview' ? 'overview' : 'jobs';
const lastClip = new Map();
let tab = 'labels', track = 'shots', selected = null, refIndex = 0, frame = 0;
let dirty = false, busy = false, loading = 0, cropUrl, drag, drawing = false;
let promptVersion = 0, promptTimer, promptError;
const video = $('video');

function element(tag, text, props = {}) {
  const node = document.createElement(tag);
  if (text != null) node.textContent = text;
  for (const [key, value] of Object.entries(props)) {
    if (key === 'title') node.dataset.tooltip = value;
    else if (key.startsWith('on')) node.addEventListener(key.slice(2), value);
    else if (key in node) node[key] = value;
    else node.setAttribute(key, value);
  }
  return node;
}
const btn = (text, fn, props = {}) => element('button', text, {type:'button', onclick:fn, ...props});
const container = (className, ...children) => {
  const node = element('div', null, {className});
  node.append(...children);
  return node;
};

function createPicker(label, choices, value, onChange, {id, minWidth = 158} = {}) {
  const menuId = id ? id + '-options' : 'picker-options-' + ++pickerCount;
  const name = element('span', null, {className:'picker-name', id:menuId+'-value'});
  const description = element('span', null, {className:'picker-description', id:menuId+'-description', hidden:true});
  const copy = container('picker-copy', name, description);
  const menu = element('div', null, {id:menuId, className:'picker-options', popover:'auto',
    role:'listbox','aria-label':label});
  const trigger = element('button', null, {type:'button',className:'picker-trigger',role:'combobox',
    'aria-label':label,'aria-haspopup':'listbox','aria-expanded':'false','aria-controls':menuId,popovertarget:menuId});
  if (id) trigger.id = id;
  trigger.append(copy, element('span',null,{className:'picker-chevron','aria-hidden':'true'}));
  const view = container('runway-picker',trigger,menu);
  let active = 0;
  const isOpen = () => menu.matches(':popover-open');
  const selected = () => choices.findIndex(choice=>choice.value===value);

  function renderSelection() {
    const current = choices[selected()];
    name.textContent = current?.label ?? '';
    description.textContent = current?.description ?? '';
    description.hidden = !current?.description;
    trigger.setAttribute('aria-describedby',current?.description?name.id+' '+description.id:name.id);
    const chosen = selected();
    [...menu.children].forEach((row,index)=>row.setAttribute('aria-selected',String(index===chosen)));
  }
  function setValue(next) {
    value = next;
    renderSelection();
  }
  function choose(index) {
    const next = choices[index].value;
    if (isOpen()) menu.hidePopover();
    trigger.focus({preventScroll:true});
    if (value===next) return;
    setValue(next);
    onChange(next);
    if (!trigger.isConnected && id) $(id)?.focus({preventScroll:true});
  }
  function update(items, next = value) {
    choices = items;
    value = next;
    menu.replaceChildren(...choices.map((choice,index)=>{
      const row = btn(null,()=>choose(index),{id:menuId+'-'+index,className:'picker-option',
        role:'option',tabIndex:-1,'aria-selected':'false'});
      const text = container('picker-copy',element('span',choice.label,{className:'picker-name'}));
      if (choice.description) text.append(element('span',choice.description,{className:'picker-description'}));
      row.append(text,element('span',null,{className:'picker-check','aria-hidden':'true'}));
      return row;
    }));
    renderSelection();
  }
  function positionMenu() {
    const bounds = trigger.getBoundingClientRect();
    if (bounds.bottom<=0 || bounds.top>=innerHeight) {
      closeMenu();
      return;
    }
    const width = Math.min(innerWidth-16, Math.max(bounds.width,minWidth));
    const below = innerHeight-bounds.bottom-12;
    const above = bounds.top-12;
    const estimated = Math.min(240,choices.reduce((height,choice)=>height+(choice.description?56:36),8));
    const dropDown = below>=estimated||below>=above;
    Object.assign(menu.style,{
      left:Math.max(8,Math.min(bounds.left,innerWidth-width-8))+'px',width:width+'px',
      top:dropDown?bounds.bottom+4+'px':'auto',bottom:dropDown?'auto':innerHeight-bounds.top+4+'px',
      maxHeight:Math.max(0,Math.min(320,dropDown?below:above))+'px'
    });
  }
  function highlight(index) {
    active = Math.max(0,Math.min(index,choices.length-1));
    [...menu.children].forEach((row,i)=>row.toggleAttribute('data-active',i===active));
    const row = menu.children[active];
    if (row) trigger.setAttribute('aria-activedescendant',row.id);
    if (isOpen()) row?.scrollIntoView({block:'nearest'});
  }
  menu.addEventListener('beforetoggle', event=>{
    const opening = event.newState==='open';
    trigger.setAttribute('aria-expanded',String(opening));
    if (opening) {
      activePicker = {menu,positionMenu,closeMenu};
      positionMenu();
      highlight(selected());
    } else {
      if (activePicker?.menu===menu) activePicker = undefined;
      trigger.removeAttribute('aria-activedescendant');
    }
  });
  trigger.addEventListener('keydown',event=>{
    if (event.key==='Tab' && isOpen()) {
      menu.hidePopover();
      return;
    }
    if (!choices.length) return;
    const wasOpen = isOpen();
    switch (event.key) {
      case 'ArrowDown':
      case 'ArrowUp':
        if (!wasOpen) menu.showPopover();
        highlight(wasOpen?active+(event.key==='ArrowDown'?1:-1):selected());
        break;
      case 'Home':
      case 'End':
        if (!wasOpen) menu.showPopover();
        highlight(event.key==='Home'?0:choices.length-1);
        break;
      case 'Enter':
      case ' ':
        if (!wasOpen) return;
        choose(active);
        break;
      case 'Escape':
        if (!wasOpen) return;
        menu.hidePopover();
        break;
      default:
        return;
    }
    event.preventDefault();
  });
  menu.addEventListener('pointerdown',event=>{
    if (event.pointerType==='mouse' && event.target.closest('[role=option]')) event.preventDefault();
  });
  update(choices,value);
  function closeMenu() {
    if (isOpen()) menu.hidePopover();
  }
  return {view,trigger,update,setValue,get value(){return value;},setDisabled(disabled){
    if (disabled && isOpen()) menu.hidePopover();
    trigger.disabled = disabled;
  }};
}
window.addEventListener('resize',()=>activePicker?.closeMenu());
document.addEventListener('scroll',event=>{
  if (activePicker && event.target!==activePicker.menu) activePicker.positionMenu();
},true);

const tooltip = element('div',null,{className:'runway-tooltip',popover:'manual',role:'tooltip'});
document.body.append(tooltip);
let tooltipAnchor, tooltipTimer;
function hideTooltip() {
  clearTimeout(tooltipTimer);
  tooltipAnchor = undefined;
  if (tooltip.matches(':popover-open')) tooltip.hidePopover();
}
function showTooltip(anchor, delay) {
  if (tooltipAnchor===anchor) return;
  hideTooltip();
  tooltipAnchor = anchor;
  tooltipTimer = setTimeout(()=>{
    if (!anchor.isConnected || !anchor.dataset.tooltip) return;
    tooltip.textContent = anchor.dataset.tooltip;
    tooltip.showPopover();
    const bounds = anchor.getBoundingClientRect();
    const width = tooltip.offsetWidth, height = tooltip.offsetHeight;
    const left = bounds.left+(bounds.width-width)/2;
    tooltip.style.left = Math.max(8,Math.min(left,innerWidth-width-8))+'px';
    tooltip.style.top = (bounds.bottom+height+12<innerHeight?bounds.bottom+6:Math.max(8,bounds.top-height-6))+'px';
  },delay);
}
document.addEventListener('pointerover',event=>{
  const anchor = event.target.closest('[data-tooltip]');
  if (anchor && event.pointerType==='mouse') showTooltip(anchor,350);
});
document.addEventListener('pointerout',event=>{
  if (tooltipAnchor?.contains(event.target) && !tooltipAnchor.contains(event.relatedTarget)) hideTooltip();
});
document.addEventListener('focusin',event=>{
  const anchor = event.target.closest('[data-tooltip]:focus-visible');
  if (anchor) showTooltip(anchor,100);
});
document.addEventListener('focusout',event=>{
  if (tooltipAnchor?.contains(event.target)) hideTooltip();
});
document.addEventListener('pointerdown',hideTooltip,true);
document.addEventListener('scroll',hideTooltip,true);
document.addEventListener('keydown',event=>{if (event.key==='Escape') hideTooltip();});
window.addEventListener('resize',hideTooltip);

const datasetPicker = createPicker('Dataset', [], undefined, openDataset, {id:'dataset-select', minWidth:208});
datasetNav.append(datasetPicker.view);
const filterPicker = createPicker('Filter by review status',
  [{value:'all',label:'All'},{value:'review',label:'To review'},{value:'confirmed',label:'Confirmed'}],
  'all', ()=>updateList(), {minWidth:142});
$('filter').append(filterPicker.view);
const clamp = (n, min, max) => Math.min(max, Math.max(min, n));
const pad = (n) => String(n).padStart(2, '0');
const stamp = (n) => {
  const fps = clip?.fps ?? 24;
  return [Math.floor(n / fps / 60), Math.floor(n / fps) % 60, n % fps].map(pad).join(':');
};
const datasetPath = (suffix = '') => './api/' + dataset + suffix;
const endpoint = (suffix = '') => datasetPath('/clip/' + clip.id + suffix);
const request = (method, value) => ({method, headers:{'Content-Type':'application/json'}, body:JSON.stringify(value)});
async function fetchJson(url, options) {
  const response = await fetch(url, options);
  const result = await response.json();
  if (!response.ok) throw new Error(result.error || response.statusText);
  return result;
}
function notice(text = '', isError = false) {
  $('notice').textContent = text;
  $('notice').classList.toggle('error', isError);
}
const reviewFlow = createReviewWorkflow({
  root:$('workflow-page'), element, btn, container, createPicker, confirmAction, fetchJson, request, notice, readOnly,
  resetScroll:() => { mainContent.scrollTop = 0; },
  getDataset:() => dataset, getDatasets:() => datasets,
  onEvaluationSection(section) {
    evaluationSection = section;
    for (const button of $('evaluation-sidebar').querySelectorAll('button')) {
      if (button.dataset.evaluationSection === section) button.setAttribute('aria-current','page');
      else button.removeAttribute('aria-current');
    }
    const params = new URLSearchParams({dataset, view:'evaluation'});
    if (section === 'overview') params.set('section',section);
    window.history.replaceState({}, '', '?' + params);
  },
  onGenerationSelection:() => {
    if (workflowMode !== 'generation') return;
    const active = reviewFlow.selectedGeneration();
    for (const button of $('clip-list').querySelectorAll('[data-clip-id]')) {
      button.setAttribute('aria-current', String(button.dataset.clipId === active));
    }
  }
});
function renderWorkflow() {
  const labeling = workflowMode === 'labeling';
  document.querySelector('.workspace').classList.toggle('wide-workflow', !labeling);
  for (const selector of ['.viewer', '.inspector', '.mast-actions', '.shortcuts']) {
    document.querySelector(selector).hidden = !labeling;
  }
  $('label-sidebar').hidden = workflowMode === 'evaluation';
  $('evaluation-sidebar').hidden = workflowMode !== 'evaluation';
  $('workflow-page').hidden = labeling;
  for (const button of document.querySelectorAll('[data-workflow]')) {
    if (button.dataset.workflow === workflowMode) button.setAttribute('aria-current','page');
    else button.removeAttribute('aria-current');
  }
}
async function openWorkflow(mode) {
  if (workflowMode === mode || busy || !(await reviewFlow.canLeave())) return;
  reviewFlow.close();
  workflowMode = mode;
  video.pause();
  notice();
  renderWorkflow();
  updateList();
  if (mode === 'labeling') {
    if (clip) window.history.replaceState({}, '', '?' + new URLSearchParams({dataset, clip:clip.id}));
    else {
      const id = lastClip.get(dataset) ?? clips.find((c) => !c.confirmed)?.id ?? clips[0]?.id;
      if (id) openClip(id);
    }
  } else {
    if (mode === 'generation') window.history.replaceState({}, '', '?' + new URLSearchParams({dataset, view:mode}));
    reviewFlow.show(mode,evaluationSection);
  }
}
function renderActions() {
  $('save').disabled = !state || busy || !dirty;
  $('confirm').disabled = !state || busy;
  $('confirm').textContent = state?.confirmed ? (dirty ? 'Reconfirm clip' : 'Reopen for editing') : 'Confirm clip';
  $('progress').textContent = clips.filter((c) => c.confirmed).length + ' / ' + clips.length + ' confirmed';
  const i = clips.findIndex((c) => c.id === clip?.id);
  $('previous').disabled = i <= 0 || busy;
  $('next').disabled = i < 0 || i >= clips.length - 1 || busy;
  datasetPicker.setDisabled(busy);
  renderAutolabel();
}
function renderAutolabel() {
  if (readOnly) return;
  const status = $('autolabel-status');
  const fresh = suggestions?.provenance?.analysis_task_id;
  const canApply = !!state && !!fresh && fresh !== state.provenance?.analysis_task_id;
  $('redo-autolabel').disabled = !state || busy || autolabel?.status === 'running' || autolabel?.status === 'unavailable';
  $('apply-autolabel').hidden = !canApply;
  $('apply-autolabel').disabled = busy;
  const message = autolabel?.status === 'running' ? 'Analyzing this clip…' :
    canApply && autolabel?.status === 'succeeded' ? 'Fresh suggestions are ready.' : autolabel?.message ?? '';
  if (status.textContent !== message) status.textContent = message;
  status.classList.toggle('error', autolabel?.status === 'failed');
}
function updateAutolabel(active, fresh) {
  if (clip !== active) return;
  clearTimeout(autolabelPoll);
  if (fresh.state) suggestions = fresh.state;
  autolabel = fresh.autolabel;
  renderAutolabel();
  if (autolabel?.status === 'running') {
    const path = endpoint('/suggestions');
    autolabelPoll = setTimeout(async () => {
      if (clip !== active) return;
      try {
        updateAutolabel(active, await fetchJson(path));
      } catch (error) {
        updateAutolabel(active, {autolabel:{status:'failed', message:error.message}});
      }
    }, 2500);
  }
}
async function redoAutolabel() {
  const active = clip;
  const path = endpoint('/autolabel');
  autolabel = {status:'running'};
  renderAutolabel();
  try {
    updateAutolabel(active, {autolabel:await fetchJson(path, request('POST', {}))});
  } catch (error) {
    updateAutolabel(active, {autolabel:{status:'failed', message:error.message}});
  }
}
async function applyAutolabel() {
  const proposed = suggestions;
  if (!(await confirmAction('Replace segment labels?', 'Use the refreshed Pegasus segments for this clip.',
    'Replace labels'))) return;
  state.tracks = structuredClone(proposed.tracks);
  state.provenance = {...proposed.provenance};
  selected = state.tracks[track][0]?.id ?? null;
  setDirty(); renderPanel(); renderTimeline();
}
function datasetSummary(item) {
  const count = `${clipCountFormat.format(item.count)} ${item.count === 1 ? 'clip' : 'clips'}`;
  return item.description ? `${count} · ${item.description}` : count;
}
function renderDatasets(active) {
  datasetPicker.update(datasets.map(item=>({value:item.id,label:item.name,description:datasetSummary(item)})),active.id);
  datasetNav.hidden = false;
}
function updateList() {
  const generating = workflowMode === 'generation';
  const active = generating ? reviewFlow.selectedGeneration() : clip?.id;
  const needle = $('search').value.toLowerCase().trim();
  const filter = filterPicker.value;
  const list = $('clip-list');
  const {scrollTop, scrollLeft} = list;
  list.replaceChildren();
  for (const item of clips) {
    if (filter === 'confirmed' && !item.confirmed || filter === 'review' && item.confirmed) continue;
    if (!(item.title + ' ' + item.id).toLowerCase().includes(needle)) continue;
    const entry = btn(null, () => generating ? reviewFlow.openGeneration(item) : openClip(item.id),
      {'aria-current':String(item.id === active), 'data-clip-id':item.id,
      title:item.title + (item.confirmed ? ' · Confirmed' : ' · To review')});
    entry.append(element('span', String(item.number ?? item.under_15s_rank).padStart(2, '0'), {className:'index'}),
      element('span', item.title), element('span', item.confirmed ? '✓' : '•',
        {className:'clip-status' + (item.confirmed ? ' done' : ''), 'aria-hidden':'true'}));
    list.append(entry);
  }
  if (!list.children.length) list.append(element('p', 'No matching clips.', {className:'empty'}));
  list.scrollTo(scrollLeft, scrollTop);
}
function confirmAction(title, message, action, cancel = 'Cancel') {
  if (confirmDialog.open) return false;
  $('review-confirm-title').textContent = title;
  $('review-confirm-description').textContent = message;
  $('review-confirm-submit').textContent = action;
  $('review-confirm-cancel').textContent = cancel;
  confirmDialog.returnValue = '';
  return new Promise((resolve) => {
    confirmDialog.addEventListener('close', () => resolve(confirmDialog.returnValue === 'confirm'), {once:true});
    confirmDialog.showModal();
  });
}
function confirmDiscardLabelEdits() {
  return confirmAction('Discard unsaved changes?', 'Your edits to this clip will be lost if you continue.',
    'Discard changes', 'Keep editing');
}
async function openDataset(id, requestedClip) {
  datasetPicker.setValue(dataset??id);
  if (busy || dataset === id || !(await reviewFlow.canLeave())) return;
  if (dirty && !(await confirmDiscardLabelEdits())) return;
  busy = true;
  renderActions();
  notice('Loading dataset…');
  try {
    const data = await fetchJson('./api/' + id + '/clips');
    reviewFlow.close();
    video.pause();
    clip = null;
    state = null;
    resetPrompt();
    suggestions = null;
    autolabel = null;
    clearTimeout(autolabelPoll);
    dirty = false;
    dataset = id;
    clips = data.clips;
    fields = data.tracks;
    $('search').value = '';
    filterPicker.setValue('all');
    $('clip-list').scrollTo(0, 0);
    $('panel').replaceChildren();
    $('lanes').replaceChildren();
    $('still').removeAttribute('src');
    $('still').hidden = true;
    $('box-layer').hidden = true;
    $('clip-title').textContent = 'Open a clip';
    const active = datasets.find((item) => item.id === id);
    $('clip-meta').textContent = active.name;
    renderDatasets(active);
    updateList();
    const preferred = requestedClip ?? lastClip.get(id);
    const first = clips.find((item) => item.id === preferred) || clips.find((item) => !item.confirmed) || clips[0];
    busy = false;
    if (workflowMode !== 'labeling') {
      if (workflowMode === 'generation') {
        window.history.replaceState({}, '', '?' + new URLSearchParams({dataset, view:workflowMode}));
      }
      reviewFlow.show(workflowMode,evaluationSection);
      notice();
    } else if (first) {
      await openClip(first.id);
    } else {
      window.history.replaceState({}, '', '?dataset=' + id);
      notice('No clips are available in this dataset.');
    }
  } catch (error) {
    notice(error.message, true);
  } finally {
    busy = false;
    renderActions();
  }
}
async function openClip(id) {
  if (!id || busy || id === clip?.id) return;
  if (dirty && !(await confirmDiscardLabelEdits())) return;
  const version = ++loading;
  busy = true;
  renderActions();
  notice('Loading clip…');
  video.pause();
  try {
    const path = datasetPath('/clip/' + id);
    const [result, fresh] = await Promise.all([fetchJson(path), readOnly ? null : fetchJson(path + '/suggestions')]);
    if (version !== loading) return;
    ({clip, state} = result);
    resetPrompt(result.prompt);
    if (fresh) updateAutolabel(clip, fresh);
    dirty = false;
    selected = state.tracks[track][0]?.id ?? null;
    refIndex = 0;
    drawing = false;
    video.src = endpoint('/media');
    $('clip-title').textContent = clip.title;
    $('clip-meta').textContent = clip.id + '  ·  ' + clip.aspect_ratio + '  ·  ' + clip.fps + ' fps';
    $('mid-time').textContent = stamp(Math.floor(clip.frames / 2)).slice(0, 5);
    $('end-time').textContent = stamp(clip.frames);
    $('last-frame').textContent = '/ ' + (clip.frames - 1);
    $('scrub').max = $('frame-number').max = clip.frames - 1;
    lastClip.set(dataset, id);
    mainContent.scrollTop = 0;
    viewer.scrollTop = 0;
    $('panel').scrollTop = 0;
    window.history.replaceState({}, '', '?' + new URLSearchParams({dataset, clip:id}));
    sizeMedia();
    setFrame(tab === 'references' ? state.references[0]?.frame ?? 0 : 0);
    renderTimeline();
    renderPanel();
    updateList();
    notice();
  } catch (error) {
    notice(error.message, true);
  } finally {
    busy = false;
    renderActions();
  }
}
function setDirty() {
  dirty = true;
  resetPrompt();
  const version = promptVersion;
  promptTimer = setTimeout(() => refreshPrompt(version), 250);
  renderActions();
  notice('Unsaved edits');
}
function resetPrompt(next) {
  clearTimeout(promptTimer);
  promptVersion++;
  prompt = next;
  promptError = undefined;
}
async function refreshPrompt(version) {
  const {tracks, references} = state;
  try {
    const data = await fetchJson(endpoint('/prompt'), request('POST', {tracks, references}));
    if (version !== promptVersion) return;
    prompt = data;
  } catch (error) {
    if (version !== promptVersion) return;
    promptError = error.message;
  }
  if (tab === 'prompt') renderPanel();
}
function sizeMedia() {
  if (!clip) return;
  const stage = $('source').parentElement.getBoundingClientRect();
  const [w, h] = (clip.aspect_ratio || clip.width + ':' + clip.height).split(':').map(Number);
  const scale = Math.min(stage.width / w, stage.height / h);
  $('source').style.setProperty('--media-width', w * scale + 'px');
  $('source').style.setProperty('--media-height', h * scale + 'px');
}
function renderClock() {
  $('timecode').textContent = stamp(frame);
  $('scrub').value = $('frame-number').value = frame;
  document.querySelectorAll('.playhead').forEach((node) => {
    node.style.left = 100 * frame / Math.max(1, clip.frames - 1) + '%';
  });
}
function setFrame(n) {
  if (!clip || !Number.isFinite(n)) return;
  if (!video.paused) video.pause();
  frame = clamp(Math.round(n), 0, clip.frames - 1);
  video.hidden = !readOnly;
  $('still').hidden = readOnly;
  if (readOnly) video.currentTime = (frame + .25) / clip.fps;
  else $('still').src = endpoint('/frame?n=' + frame);
  $('stage-note').textContent = 'Exact frame';
  renderClock();
  drawBox();
}
const playbackFrame = () => clamp(Math.floor(video.currentTime * clip.fps + 0.001), 0, clip.frames - 1);
async function togglePlay() {
  if (!clip) return;
  if (!video.paused) {
    video.pause();
    return;
  }
  try {
    if (frame === clip.frames - 1) frame = 0;
    video.currentTime = (frame + .25) / clip.fps;
    await video.play();
    video.hidden = false;
    $('still').hidden = true;
    $('box-layer').hidden = true;
    $('play').textContent = 'Pause';
    $('stage-note').textContent = 'Playing source';
    requestAnimationFrame(tick);
  } catch (error) {
    notice('Playback failed. ' + error.message, true);
  }
}
function tick() {
  if (!clip || video.paused) return;
  frame = playbackFrame();
  renderClock();
  requestAnimationFrame(tick);
}
video.addEventListener('pause', () => {
  $('play').textContent = 'Play';
  if (clip && !video.hidden && (!readOnly || $('stage-note').textContent === 'Playing source')) {
    setFrame(playbackFrame());
  }
});

function selectTrack(key, id, seek = false) {
  track = key;
  selected = id ?? state.tracks[key][0]?.id ?? null;
  switchTab('labels');
  const row = state.tracks[key].find((entry) => entry.id === selected);
  if (row && seek) setFrame(row.start);
  renderTimeline();
}
function segmentBoundary(key, row, edge) {
  const start = edge === 'start';
  const neighborEdge = start ? 'end' : 'start';
  const neighbor = key === 'shots'
    ? state.tracks[key].find((other) => other !== row && other[neighborEdge] === row[edge])
    : undefined;
  const min = start ? (neighbor ? neighbor.start + 1 : 0) : row.start + 1;
  const max = start ? row.end - 1 : (neighbor ? neighbor.end - 1 : clip.frames);
  return {min, max, neighbor, neighborEdge};
}
function editSegmentBoundary(key, row, edge, value) {
  const {min, max, neighbor, neighborEdge} = segmentBoundary(key, row, edge);
  const next = clamp(value, min, max);
  if (next === row[edge]) return false;
  row[edge] = next;
  if (neighbor) neighbor[neighborEdge] = next;
  setDirty(); renderPanel(); renderTimeline();
  return true;
}
function positionSegment(button, start, end) {
  button.style.left = start / clip.frames * 100 + '%';
  button.style.width = (end - start) / clip.frames * 100 + '%';
}
function segmentHandle(key, row, edge, bar, buttons) {
  const {min, max, neighbor, neighborEdge} = segmentBoundary(key, row, edge);
  const handle = element('span', null, {className:'segment-handle', role:'slider', tabIndex:0,
    'data-edge':edge, 'aria-label':edge === 'start' ? 'Segment start' : 'Segment end (exclusive)',
    'aria-valuemin':min, 'aria-valuemax':max});
  let drag;

  function position(value) {
    handle.style.left = value / clip.frames * 100 + '%';
    handle.dataset.timecode = stamp(value);
    handle.setAttribute('aria-valuenow', value);
    handle.setAttribute('aria-valuetext', 'Frame ' + value + ' · ' + stamp(value));
  }
  function preview(value) {
    positionSegment(buttons.get(row), edge === 'start' ? value : row.start, edge === 'end' ? value : row.end);
    if (neighbor) positionSegment(buttons.get(neighbor),
      neighborEdge === 'start' ? value : neighbor.start, neighborEdge === 'end' ? value : neighbor.end);
    position(value);
  }
  function pointerFrame(event) {
    const delta = (event.clientX - drag.x) * clip.frames / drag.width;
    return clamp(Math.round(row[edge] + delta), min, max);
  }
  function commit(value) {
    const focused = document.activeElement === handle;
    if (!editSegmentBoundary(key, row, edge, value)) {
      preview(row[edge]);
    } else if (focused) {
      $('lanes').querySelector('.segment-handle[data-edge="' + edge + '"]')?.focus({preventScroll:true});
    }
  }
  handle.addEventListener('pointerdown', (event) => {
    if (!event.isPrimary || event.button !== 0 || busy) return;
    event.preventDefault();
    handle.focus({preventScroll:true});
    handle.setPointerCapture(event.pointerId);
    drag = {id:event.pointerId, x:event.clientX, width:bar.clientWidth};
    handle.classList.add('dragging');
  });
  handle.addEventListener('pointermove', (event) => {
    if (drag?.id === event.pointerId) preview(pointerFrame(event));
  });
  for (const type of ['pointerup','pointercancel','lostpointercapture']) {
    handle.addEventListener(type, (event) => {
      if (drag?.id !== event.pointerId) return;
      const value = type === 'pointerup' ? pointerFrame(event) : row[edge];
      drag = null;
      handle.classList.remove('dragging');
      commit(value);
    });
  }
  handle.addEventListener('keydown', (event) => {
    const values = {ArrowLeft:row[edge]-1, ArrowDown:row[edge]-1,
      ArrowRight:row[edge]+1, ArrowUp:row[edge]+1, Home:min, End:max};
    if (drag || busy || !Object.hasOwn(values, event.key)) return;
    event.preventDefault();
    commit(values[event.key]);
  });
  position(row[edge]);
  return handle;
}
function renderTimeline() {
  if (!state) return;
  const lanes = $('lanes');
  lanes.replaceChildren();
  for (const [key, label] of Object.entries(names)) {
    const bar = container('bar');
    bar.addEventListener('click', (event) => {
      if (event.target !== bar) return;
      const bounds = bar.getBoundingClientRect();
      setFrame((event.clientX - bounds.left) / bounds.width * (clip.frames - 1));
    });
    const active = key === track && tab === 'labels' ? state.tracks[key].find((row) => row.id === selected) : null;
    const buttons = new Map();
    for (const row of state.tracks[key]) {
      const button = btn(null, () => selectTrack(key, row.id, true), {
        className:'segment' + (row === active ? ' active' : ''),
        title:stamp(row.start) + '–' + stamp(row.end) + ' ' + row.label,
        'aria-label':label + ' segment ' + (row.label || stamp(row.start))});
      positionSegment(button, row.start, row.end);
      buttons.set(row, button);
      bar.append(button);
    }
    bar.append(element('span', null, {className:'playhead'}));
    if (active && !readOnly) bar.append(segmentHandle(key, active, 'start', bar, buttons),
      segmentHandle(key, active, 'end', bar, buttons));
    lanes.append(container('lane', btn(label, () => selectTrack(key), {
      className:'lane-name' + (key === track && tab === 'labels' ? ' active' : '')}), bar));
  }
  renderClock();
}
function labeled(text, control) {
  const label = element('label', text);
  label.append(control);
  return label;
}
function selectInput(title, values, value, callback) {
  return createPicker(title,Object.entries(values).map(([value,label])=>({value,label})),value,callback,
    {id:title==='Label track'?'label-track':undefined}).view;
}
function numeric(label, value, min, max, change) {
  return element('input', null, {type:'number', 'aria-label':label, value, min, max,
    onchange:(event) => {
      const input = event.target;
      if (input.value === '') { input.value = value; return; }
      const safe = clamp(Math.round(Number(input.value)), min, max);
      input.value = safe;
      change(safe);
    }});
}
function renderLabels(panel) {
  const segmentSource = state.provenance?.segments || 'Awaiting segment suggestions';
  const analysisVersion = state.provenance?.analysis_version;
  const provenance = container('provenance notes', element('span', 'Segment source · ' + segmentSource +
    (analysisVersion === 'visual-detail-v2' ? ' · Detailed analysis' : '')));
  if (state.provenance?.provider_warning) provenance.append(element('p', state.provenance.provider_warning));
  const rows = state.tracks[track];
  const header = container('section-row', selectInput('Label track', names, track, (key) => selectTrack(key)));
  if (!readOnly) header.append(btn('Add segment', () => {
    let start = frame, end = Math.min(clip.frames, frame + clip.fps);
    if (track === 'shots') {
      const containing = rows.find((row) => row.start < frame && frame < row.end);
      if (containing) {
        end = containing.end;
        containing.end = frame;
      } else if (!rows.length) { start = 0; end = clip.frames; }
      else if (rows.some((row) => row.start === frame)) {
        notice('Move the playhead inside the shot to split it.'); return;
      } else {
        const following = rows.find((row) => row.start > frame);
        end = following?.start ?? clip.frames;
      }
    }
    const row = {id:crypto.randomUUID(), start, end, label:''};
    rows.push(row);
    rows.sort((a,b) => a.start-b.start || a.end-b.end);
    selected = row.id;
    setDirty(); renderPanel(); renderTimeline();
    $('panel').querySelector('[aria-label="Label"]')?.focus();
  }));
  const list = container('stack');
  for (const row of rows) {
    const option = btn(null, () => selectTrack(track, row.id, true), {className: row.id === selected ? 'active' : ''});
    option.append(element('span', stamp(row.start) + '–' + stamp(row.end), {className:'segment-time'}), row.label || 'Untitled segment');
    list.append(option);
  }
  panel.append(provenance, header, list);
  if (!rows.length) panel.append($('empty').content.cloneNode(true));
  const row = rows.find((r) => r.id === selected);
  if (!row) return;
  if (readOnly) {
    panel.append(annotationDetails([
      ['Start', stamp(row.start)], ['End', stamp(row.end)],
      ...fields[track].map(field=>[fieldNames[field],row[field]]),
    ]));
    return;
  }
  const start = segmentBoundary(track, row, 'start');
  const end = segmentBoundary(track, row, 'end');
  const setBoundary = (edge, value) => editSegmentBoundary(track, row, edge, value);
  const editor = container('editor',
    container('frame-fields', labeled('Start frame', numeric('Start frame', row.start, start.min, start.max, (n) => setBoundary('start', n))),
      labeled('End frame (exclusive)', numeric('End frame (exclusive)', row.end, end.min, end.max, (n) => setBoundary('end', n)))),
    container('row-actions', btn('Start at playhead', () => setBoundary('start', frame)),
      btn('End after playhead', () => setBoundary('end', frame + 1))));
  for (const field of fields[track]) {
    const title = field === 'label' && track === 'text_on_screen' ? 'Visible text' :
      field === 'label' && track === 'dialogue' ? 'Spoken words' : fieldNames[field];
    const multiline = ['detail','audio','composition','motion','palette','placement','camera'].includes(field) ||
      field === 'label' && ['text_on_screen','dialogue'].includes(track);
    const control = element(multiline ? 'textarea' : 'input', null, {'aria-label':title, value:row[field] || '',
      oninput:(event) => { row[field] = event.target.value; setDirty(); },
      onchange:() => { if (field === 'label') renderTimeline(); }});
    editor.append(labeled(title, control));
  }
  editor.append(btn('Delete segment', () => {
    const index = rows.indexOf(row);
    rows.splice(index, 1);
    selected = (rows[index] || rows[index - 1])?.id ?? null;
    setDirty(); renderPanel(); renderTimeline();
  }));
  panel.append(editor);
}
function drawBox() {
  const ref = state?.references[refIndex];
  const active = Boolean(ref && tab === 'references' && video.paused && frame === ref.frame);
  $('box-layer').hidden = !active;
  $('box').hidden = !active;
  $('box-layer').classList.toggle('drawing', drawing);
  if (!active) return;
  const [x1,y1,x2,y2] = ref.box;
  Object.assign($('box').style, {left:x1/clip.width*100+'%', top:y1/clip.height*100+'%',
    width:(x2-x1)/clip.width*100+'%', height:(y2-y1)/clip.height*100+'%'});
}
function annotationDetails(fields) {
  const details = element('dl',null,{className:'editor archive-details'});
  for (const [label,value] of fields) {
    if (value) details.append(element('dt',label),element('dd',value));
  }
  return details;
}
function referencePreview(img, reference) {
  if (cropUrl) { URL.revokeObjectURL(cropUrl); cropUrl = null; }
  if (reference.file) {
    img.src = endpoint('/reference?file=' + reference.file.split('/').at(-1));
    return;
  }
  if (readOnly) return;
  fetch(endpoint('/crop'), request('POST', reference)).then(async (response) => {
    if (!response.ok) throw new Error('Reference preview could not be rendered.');
    const data = await response.blob();
    if (!img.isConnected) return;
    cropUrl = URL.createObjectURL(data);
    img.src = cropUrl;
  }).catch((error) => { if (img.isConnected) notice(error.message, true); });
}
function editBox(reference, box, rerender = true) {
  reference.box = box;
  delete reference.file;
  setDirty(); drawBox();
  if (rerender) renderPanel();
}
function renderReferences(panel) {
  const refs = state.references;
  const title = container('section-row', element('h3', refs.length + ' of 5 reference images'));
  if (!readOnly) title.append(btn('Add reference', () => {
      const label = 'Reference ' + (refs.length + 1);
      refs.push({label, kind:'object', frame, box:[Math.round(clip.width*.2), Math.round(clip.height*.2),
        Math.round(clip.width*.8), Math.round(clip.height*.8)]});
      refIndex = refs.length - 1;
      setDirty(); renderPanel();
    }, {disabled:refs.length >= 5}));
  const list = container('stack');
  refs.forEach((ref, index) => list.append(btn((index+1) + '. ' + ref.label, () => {
    refIndex = index; drawing = false; setFrame(ref.frame); renderPanel();
  }, {className:index === refIndex ? 'active' : ''})));
  panel.append(title);
  if (!readOnly) panel.append(element('p', 'Order determines importance. Draw, move or resize the box on its source frame.',
    {className:'notes panel-block'}));
  panel.append(list);
  const ref = refs[refIndex];
  if (!ref) { panel.append(element('p', 'No reference images yet.', {className:'empty'})); return; }
  const image = element('img', null, {className:'thumbnail', alt:'Cropped reference preview'});
  if (readOnly) {
    panel.append(image,annotationDetails([['Entity name',ref.label],['Reference type',ref.kind],
      ['Reference frame',stamp(ref.frame)],['Crop bounds',ref.box.join(', ')]]));
    referencePreview(image, ref);
    return;
  }
  const frameField = numeric('Reference frame', ref.frame, 0, clip.frames-1, (n) => {
    ref.frame = n; delete ref.file; setDirty(); setFrame(n); renderPanel();
  });
  const fieldList = ['Left', 'Top', 'Right', 'Bottom'];
  const boxFields = container('bbox-fields');
  const [x1,y1,x2,y2] = ref.box;
  fieldList.forEach((field, index) =>
    boxFields.append(labeled(field, numeric(field, ref.box[index], [0,0,x1+1,y1+1][index],
      [x2-1,y2-1,clip.width,clip.height][index], (value) => {
        const updated = [...ref.box]; updated[index] = value; editBox(ref, updated);
      }))));
  function move(delta) {
    [refs[refIndex], refs[refIndex + delta]] = [refs[refIndex + delta], refs[refIndex]];
    refIndex += delta; setDirty(); renderPanel();
  }
  const editor = container('editor', image, labeled('Entity name',
    element('input', null, {value:ref.label, maxLength:100, oninput:(event) => {
      ref.label=event.target.value; setDirty();
    }})),
    container('editor-field',element('span','Reference type'),
      selectInput('Reference type', Object.fromEntries(types.map((t)=>[t,t])),
        ref.kind, (t)=>{ref.kind=t; setDirty();})), labeled('Reference frame', frameField),
    container('row-actions', btn('Go to reference frame', () => setFrame(ref.frame)),
      btn('Draw box', () => {
        drawing = true; setFrame(ref.frame);
        notice('Drag across the source frame to draw a new box.');
      }),
      btn('Use playhead', () => {ref.frame=frame; delete ref.file; setDirty(); renderPanel();})),
    boxFields,
    container('row-actions', btn('Move up', () => move(-1), {disabled:refIndex===0}),
      btn('Move down', () => move(1), {disabled:refIndex===refs.length-1}),
      btn('Delete reference', () => {
        refs.splice(refIndex,1); refIndex=Math.max(0,Math.min(refIndex,refs.length-1));
        if (refs[refIndex]) setFrame(refs[refIndex].frame);
        setDirty(); renderPanel();
      })));
  panel.append(editor);
  referencePreview(image, ref);
}

function renderPrompt(panel) {
  if (!prompt) {
    panel.append(element('p', promptError ?? 'Building shared reconstruction prompt…',
      {className:'notes', role:'status'}));
    return;
  }
  const {text, limit, source_duration, ratio, valid, notes} = prompt;
  const characters = Array.from(text).length;
  const metrics = container('prompt-metrics', element('span', characters + ' / ' + limit + ' characters'),
    element('span', source_duration + 's source'), element('span', ratio + ' output'),
    element('span', state.references.length + ' references'));
  const preview = element('textarea', null, {className:'prompt-text', value:text, readOnly:true,
    'aria-label':'Reconstruction prompt'});
  const links = container('export-buttons', btn('Copy prompt', async () => {
    try { await navigator.clipboard.writeText(text); notice('Prompt copied.'); }
    catch (error) { preview.focus(); preview.select(); notice('Copy this selection.'); }
  }, {disabled:!valid}));
  for (const [model, name] of Object.entries(readOnly ? {} : enabledModels)) {
    links.append(btn('Export ' + name, () => { window.location.href = endpoint('/export?model=' + model); },
      {disabled:!valid || !state.confirmed || dirty}));
  }
  panel.append(element('h3', 'Shared reconstruction prompt'), metrics, preview, links);
  if (!readOnly && Object.keys(enabledModels).length && (!state.confirmed || dirty)) {
    panel.append(element('p', 'Confirm the clip to enable request exports.', {className:'notes'}));
  }
  for (const note of notes) panel.append(element('p', note, {className:'notes'}));
}

function renderPanel() {
  if (!state) return;
  const panel = $('panel');
  const scrollTop = panel.scrollTop;
  panel.replaceChildren();
  if (tab === 'labels') renderLabels(panel);
  else if (tab === 'references') renderReferences(panel);
  else renderPrompt(panel);
  panel.scrollTop = scrollTop;
  drawBox();
}

function switchTab(name) {
  if (!clip) return;
  const changed = name !== tab;
  tab = name;
  if (changed) $('panel').scrollTop = 0;
  for (const button of document.querySelectorAll('[data-tab]')) {
    const active = button.dataset.tab === name;
    button.classList.toggle('selected', active);
    button.setAttribute('aria-pressed', String(active));
  }
  if (changed && tab === 'references' && state.references[refIndex]) setFrame(state.references[refIndex].frame);
  if (changed && tab === 'prompt' && promptError) {
    promptError = undefined;
    refreshPrompt(promptVersion);
  }
  renderPanel(); renderTimeline();
}

function point(event) {
  const rect = $('box-layer').getBoundingClientRect();
  return [clamp(Math.round((event.clientX - rect.left) / rect.width * clip.width), 0, clip.width),
    clamp(Math.round((event.clientY - rect.top) / rect.height * clip.height), 0, clip.height)];
}
$('box-layer').addEventListener('pointerdown', (event) => {
  if (readOnly || event.button !== 0) return;
  const reference = state.references[refIndex];
  drag = {reference, origin:point(event), initial:[...reference.box],
    mode:drawing ? 'draw' : event.target.dataset.handle || (event.target === $('box') ? 'move' : 'draw')};
  $('box-layer').setPointerCapture(event.pointerId);
});
$('box-layer').addEventListener('pointermove', (event) => {
  if (!drag) return;
  const [x,y] = point(event);
  const [ox,oy] = drag.origin;
  const [x1,y1,x2,y2] = drag.initial;
  let box;
  if (drag.mode === 'move') {
    const dx = clamp(x-ox,-x1,clip.width-x2), dy = clamp(y-oy,-y1,clip.height-y2);
    box = [x1+dx,y1+dy,x2+dx,y2+dy];
  } else if (drag.mode === 'draw') {
    if (Math.abs(x-ox)<2 || Math.abs(y-oy)<2) return;
    box = [Math.min(x,ox),Math.min(y,oy),Math.max(x,ox),Math.max(y,oy)];
  } else {
    const w = drag.mode.endsWith('w'), n = drag.mode.startsWith('n');
    box = [w ? Math.min(x,x2-1) : x1, n ? Math.min(y,y2-1) : y1,
      w ? x2 : Math.max(x,x1+1), n ? y2 : Math.max(y,y1+1)];
  }
  editBox(drag.reference, box, false);
});
for (const event of ['pointerup','pointercancel']) {
  $('box-layer').addEventListener(event, () => {
    if (!drag) return;
    drag = null;
    drawing = false;
    renderPanel();
  });
}

async function save(confirmed) {
  if (!state || busy) return;
  const reopening = state.confirmed && !confirmed;
  const version = promptVersion;
  busy = true; renderActions(); notice('Saving to disk…');
  try {
    const saved = await fetchJson(endpoint(), request('PUT', {...state, confirmed}));
    if (version === promptVersion) {
      state = saved;
      dirty = false;
      resetPrompt(saved.prompt);
    } else {
      state.confirmed = saved.confirmed;
      state.revision = saved.revision;
    }
    clip.confirmed = saved.confirmed;
    clip.revision = saved.revision;
    Object.assign(clips.find((record) => record.id === clip.id), {
      confirmed: saved.confirmed, revision: saved.revision, provenance: saved.provenance
    });
    updateList();
    if (!dirty || tab === 'prompt') renderPanel();
    if (!dirty) renderTimeline();
    notice(dirty ? 'Unsaved edits' : confirmed ? 'Clip confirmed and saved.' :
      reopening ? 'Clip reopened for editing.' : 'Draft saved to disk.');
  } catch (error) {
    notice(error.message, true);
  } finally {
    busy = false; renderActions();
  }
}

$('play').addEventListener('click', togglePlay);
$('back-frame').addEventListener('click', () => setFrame(frame - 1));
$('forward-frame').addEventListener('click', () => setFrame(frame + 1));
$('scrub').addEventListener('input', (event) => setFrame(Number(event.target.value)));
$('frame-number').addEventListener('change', (event) => setFrame(Number(event.target.value)));
$('search').addEventListener('input', updateList);
$('save').addEventListener('click', () => save(false));
$('confirm').addEventListener('click', () => save(!state?.confirmed || dirty));
$('redo-autolabel').addEventListener('click', redoAutolabel);
$('apply-autolabel').addEventListener('click', applyAutolabel);
$('previous').addEventListener('click', () => openClip(clips[clips.findIndex((c)=>c.id===clip.id)-1]?.id));
$('next').addEventListener('click', () => openClip(clips[clips.findIndex((c)=>c.id===clip.id)+1]?.id));
for (const button of document.querySelectorAll('[data-tab]')) {
  button.addEventListener('click', () => switchTab(button.dataset.tab));
}
for (const button of document.querySelectorAll('[data-workflow]')) {
  button.addEventListener('click', () => openWorkflow(button.dataset.workflow));
}
for (const button of $('evaluation-sidebar').querySelectorAll('button')) {
  button.addEventListener('click',async ()=>{
    if (!dataset || busy || !(await reviewFlow.canLeave())) return;
    notice();
    reviewFlow.show('evaluation',button.dataset.evaluationSection);
  });
}
document.addEventListener('keydown', (event) => {
  if (workflowMode !== 'labeling' || confirmDialog.open || event.metaKey || event.ctrlKey || event.altKey || event.target.closest('input,textarea,button,a')) return;
  if (event.code === 'Space') { event.preventDefault(); togglePlay(); }
  if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') {
    event.preventDefault(); setFrame(frame + (event.key === 'ArrowLeft' ? -1 : 1));
  }
});
window.addEventListener('beforeunload', (event) => {
  if (dirty || reviewFlow.hasUnsaved()) { event.preventDefault(); event.returnValue = ''; }
});
new ResizeObserver(sizeMedia).observe($('source').parentElement);

fetchJson('./api/datasets').then((data) => {
  datasets = data.datasets;
  enabledModels = data.models;
  const params = new URLSearchParams(window.location.search);
  const initial = datasets.find(({id}) => id === params.get('dataset')) ?? datasets[0];
  renderWorkflow();
  if (initial) {
    renderDatasets(initial);
    openDataset(initial.id, params.get('clip'));
  }
}).catch((error) => notice(error.message, true));

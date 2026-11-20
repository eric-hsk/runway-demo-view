const statusLabels = {
  not_started:'Not started', queued:'Queued', submitting:'Submitting', pending:'Pending',
  running:'Generating', throttled:'Waiting for capacity', saving:'Saving video',
  succeeded:'Ready', failed:'Failed', cancelled:'Cancelled', download_failed:'Download failed',
  needs_attention:'Check Runway'
};
const variantLabels = {'with-first-frame':'With first frame','without-first-frame':'Without first frame'};
const variantOrder = ['without-first-frame','with-first-frame'];
const retryable = new Set(['failed','cancelled','download_failed']);
const inProgress = new Set(['queued','submitting','pending','running','throttled','saving']);
const jobCollator = new Intl.Collator(undefined,{numeric:true,sensitivity:'base'});
const noModels = 'No generation models are enabled.';
const timingBands = [
  {label:'Exact',tone:'exact'},
  {label:'Within ±0.100 s',tone:'tight'},
  {label:'Over 0.100 s through 0.300 s',tone:'near'},
  {label:'Outside ±0.300 s',tone:'outside'}
];
const signedTimingBands = [
  {label:'< −0.300 s',tone:'early-outside'},
  {label:'−0.300 s to < −0.100 s',tone:'early-near'},
  {label:'−0.100 s to < 0 s',tone:'early-tight'},
  {label:'0 s',tone:'exact'},
  {label:'> 0 s to +0.100 s',tone:'tight'},
  {label:'> +0.100 s to +0.300 s',tone:'near'},
  {label:'> +0.300 s',tone:'outside'},
  {label:'Absent',tone:'absent'}
];
const shotDurationBands = [
  {label:'Within 0.5 s',tone:'tight'},
  {label:'Over 0.5 s through 1.0 s',tone:'near'},
  {label:'Over 1.0 s',tone:'outside'}
];
const evaluationIcons = {
  previousFrame:'M6 6v12m12-12-8 6 8 6z',
  nextFrame:'M18 6v12M6 6l8 6-8 6z',
  previousEvent:'m15 6-6 6 6 6',
  nextEvent:'m9 6 6 6-6 6',
  seekEvent:'M12 3v3m0 12v3M3 12h3m12 0h3m-3 0a6 6 0 1 1-12 0 6 6 0 0 1 12 0z',
  play:'M8 5l12 7-12 7z',
  pause:'M9 5v14m6-14v14',
  audioOn:'M3 9v6h4l5 4V5L7 9zM16 9a4 4 0 0 1 0 6m3-9a8 8 0 0 1 0 12',
  audioOff:'M3 9v6h4l5 4V5L7 9zM16 9l6 6m0-6-6 6',
  fullscreen:'M9 4H4v5m11-5h5v5M4 15v5h5m11-5v5h-5',
  absent:'m6 6 12 12M18 6 6 18',
  mark:'m5 12 4 4L19 6',
  submit:'M12 16V4m-4 4 4-4 4 4M5 14v6h14v-6'
};

export function createReviewWorkflow({root, element, btn, container, createPicker, confirmAction, fetchJson, request, notice, readOnly,
  getDataset, getDatasets, onGenerationSelection, onEvaluationSection, resetScroll}) {
  let version = 0, refresh, stopEvaluation, blindMarks = false, generationClip;
  let generationSort, generationRead = 0;
  const queueingDatasets = new Set();
  const path = (resource) => './api/' + getDataset() + '/' + resource;
  const status = (name) => element('span',statusLabels[name] || name,{className:'job-status status-'+name});
  const title = (name, help) => container('workflow-heading',element('h1',name),
    ...(help ? [element('p',help,{className:'muted'})] : []));
  const close = () => {
    stopEvaluation?.();
    stopEvaluation = undefined;
    root.querySelectorAll('video').forEach(media=>media.pause());
    ++version; clearTimeout(refresh); root.replaceChildren(); blindMarks = false;
    resetScroll();
    if (generationClip) {
      generationClip = undefined;
      onGenerationSelection();
    }
  };
  const canLeave = () => !blindMarks || confirmAction('Discard unsaved evaluation marks?',
    'Your shot marks will be lost if you continue.', 'Discard marks', 'Keep editing');
  const returnTo = (mode, label) => btn(label, async () => {if (await canLeave()) show(mode);});
  const fail = (error, token) => {if (token === version) notice(error.message,true);};

  function evaluationAction(icon, label, run, primary = false) {
    const button = btn(null,run,{className:'evaluation-action'+(primary?' primary':''),title:label,'aria-label':label});
    const ns = 'http://www.w3.org/2000/svg';
    const svg = document.createElementNS(ns,'svg');
    svg.setAttribute('viewBox','0 0 24 24');
    svg.setAttribute('aria-hidden','true');
    const stroke = document.createElementNS(ns,'path');
    stroke.setAttribute('d',evaluationIcons[icon]);
    svg.append(stroke);
    button.append(svg);
    return button;
  }
  function updateIcon(button, icon, label) {
    button.querySelector('path').setAttribute('d',evaluationIcons[icon]);
    button.dataset.tooltip=label;
    button.setAttribute('aria-label',label);
  }

  function frameAt(times, time) {
    let left=0, right=times.length;
    while (left+1<right) {
      const mid=(left+right)>>1;
      if (times[mid]<=time+1e-7) left=mid;
      else right=mid;
    }
    return left;
  }

  function comparisonTransport(source, original, originalShots, fps, onFrame, onShot) {
    const audible={original:false,candidate:false};
    const first=prepare(original,source,'original');
    let second, leader, points, end, time=0, playing=false, animation, run=0;
    const slider=element('input',null,{type:'range',min:0,step:'any','aria-label':'Shared timeline',
      oninput:event=>scrub(Number(event.target.value)),onkeydown:handleSliderKey});
    const originalTrack=shotTrack('Original');
    const candidateTrack=shotTrack('Candidate');
    const output=element('output',null,{className:'evaluation-frame'});
    const play=evaluationAction('play','Play both videos',start,true);
    const pause=evaluationAction('pause','Pause both videos',()=>seek(currentTime()));
    const previous=evaluationAction('previousFrame','Previous shared frame',()=>step(-1));
    const next=evaluationAction('nextFrame','Next shared frame',()=>step(1));
    const view=container('evaluation-scrub',
      container('evaluation-tracks',element('span','Playhead',{className:'evaluation-track-label'}),slider,
        originalTrack.label,originalTrack.bar,candidateTrack.label,candidateTrack.bar),
      container('evaluation-frame-controls',previous,play,pause,next,output));

    function shotTrack(name) {
      const label=element('span',name,{className:'evaluation-track-label'});
      const bar=container('bar evaluation-shot-bar');
      const playhead=element('span',null,{className:'playhead','aria-hidden':'true'});
      bar.setAttribute('role','group');
      bar.setAttribute('aria-label',name+' segments');
      bar.addEventListener('click',event=>{
        if (event.target!==bar) return;
        const bounds=bar.getBoundingClientRect();
        scrub((event.clientX-bounds.left-bar.clientLeft)*end/bar.clientWidth);
      });
      return {label,bar,playhead};
    }
    function renderShots(candidateShots, activeIndex) {
      for (const [track,shots] of [[originalTrack,originalShots],[candidateTrack,candidateShots]]) {
        const focused=track.bar.contains(document.activeElement)?document.activeElement.dataset.shot:undefined;
        const segments=shots.map(shot=>{
          const title=shot.title+' · '+shot.start.toFixed(3)+'–'+shot.end.toFixed(3)+' s';
          const segment=btn(null,()=>{
            seek(shot.start);
            onShot(shot.index);
          },{className:shot.index===activeIndex?'segment active':'segment',title,'aria-label':title,
            'data-shot':shot.index,'aria-current':shot.index===activeIndex?'true':'false'});
          segment.style.left=100*shot.start/end+'%';
          segment.style.width=100*(shot.end-shot.start)/end+'%';
          return segment;
        });
        track.bar.replaceChildren(...segments,track.playhead);
        if (focused!==undefined) track.bar.querySelector(`[data-shot="${focused}"]`)?.focus({preventScroll:true});
      }
    }
    function prepare(playerView, timing, role) {
      const {view,media}=playerView;
      media.preload='auto';
      const label=role==='original'?'Original audio':'Candidate audio';
      const audio=evaluationAction('audioOff',label,()=>{
        audible[role]=!audible[role];
        setAudio();
      });
      audio.classList.add('evaluation-audio');
      function setAudio() {
        const enabled=audible[role];
        media.muted=!enabled;
        audio.setAttribute('aria-pressed',String(enabled));
        audio.dataset.tooltip=(enabled?'Mute ':'Unmute ')+role+' audio';
        audio.querySelector('path').setAttribute('d',evaluationIcons[enabled?'audioOn':'audioOff']);
      }
      setAudio();
      const title=view.querySelector('h3');
      const heading=container('evaluation-player-heading');
      title.replaceWith(heading);
      heading.append(title,audio);
      const ended=element('p','Video ended',{className:'evaluation-no-frame',hidden:true});
      view.append(ended);
      return {media,ended,...timing};
    }
    function currentTime() {
      return playing?Math.min(leader.media.currentTime,end):time;
    }
    function stop() {
      playing=false;
      run++;
      cancelAnimationFrame(animation);
      first.media.pause();
      second?.media.pause();
      play.hidden=false;
      if (pause===document.activeElement) play.focus({preventScroll:true});
      pause.hidden=true;
    }
    function renderTime(value) {
      time=value;
      const index=frameAt(points,time);
      slider.value=time;
      const sourceFrame=Math.floor(time*fps+1e-6);
      const wholeSeconds=Math.floor(sourceFrame/fps);
      const timecode=[Math.floor(wholeSeconds/60),wholeSeconds%60,sourceFrame%fps]
        .map(value=>String(value).padStart(2,'0')).join(':');
      slider.setAttribute('aria-valuetext',timecode);
      for (const track of [originalTrack,candidateTrack]) track.playhead.style.left=100*time/end+'%';
      output.textContent=time<second.duration?timecode+' · Candidate frame '+frameAt(second.times,time):timecode;
      previous.disabled=index===0;
      next.disabled=index===points.length-1;
      for (const item of [first,second]) {
        const ended=time>=item.duration;
        item.media.hidden=ended;
        item.ended.hidden=!ended;
      }
      onFrame(time<second.duration);
    }
    function seek(value) {
      stop();
      const target=Math.min(Math.max(0,value),end);
      for (const item of [first,second]) {
        const mediaTime=Math.min(target,item.duration);
        if (item.media.currentTime!==mediaTime) item.media.currentTime=mediaTime;
      }
      renderTime(target);
    }
    function step(direction) {
      const index=frameAt(points,currentTime());
      seek(points[Math.min(Math.max(index+direction,0),points.length-1)]);
    }
    function scrub(value) {
      const index=frameAt(points,value);
      const previousTime=points[index], nextTime=points[index+1];
      seek(nextTime!==undefined&&value-previousTime>nextTime-value?nextTime:previousTime);
    }
    function handleSliderKey(event) {
      const direction={ArrowLeft:-1,ArrowDown:-1,ArrowRight:1,ArrowUp:1}[event.key];
      if (direction) step(direction);
      else if (event.key==='Home') seek(points[0]);
      else if (event.key==='End') seek(points.at(-1));
      else return;
      event.preventDefault();
    }
    function setCandidate(playerView, timing) {
      const position=currentTime();
      stop();
      second=prepare(playerView,timing,'candidate');
      candidateTrack.label.textContent=timing.label;
      candidateTrack.bar.setAttribute('aria-label',timing.label+' segments');
      leader=first.duration>=second.duration?first:second;
      end=leader.duration;
      points=[...first.times,...second.times,...originalShots.map(shot=>shot.start)].filter(t=>t<end).sort((a,b)=>a-b)
        .filter((t,i,values)=>i===0 || t-values[i-1]>1e-7);
      slider.max=end;
      seek(position);
    }
    async function start() {
      if (playing) return;
      seek(time>=end?0:time);
      playing=true;
      pause.hidden=false;
      if (play===document.activeElement) pause.focus({preventScroll:true});
      play.hidden=true;
      const sequence=++run;
      const pair=[first,second];
      try {
        await Promise.all(pair.filter(item=>time<item.duration).map(item=>item.media.play()));
      } catch (error) {
        if (sequence===run) {
          seek(currentTime());
          notice('Playback could not start. '+error.message,true);
        }
        return;
      }
      if (sequence!==run) return;
      function tick() {
        const position=currentTime();
        if (leader.media.ended || position>=end || pair.some(({media,duration})=>
          position<duration && !media.seeking && media.readyState<2)) {
          seek(position);
          return;
        }
        for (const item of pair) {
          if (item!==leader && position<item.duration && !item.media.seeking &&
              Math.abs(item.media.currentTime-position)>1/(4*fps)) {
            item.media.currentTime=position;
          }
        }
        renderTime(position);
        animation=requestAnimationFrame(tick);
      }
      tick();
    }
    return {view,setCandidate,renderShots,seek,stop,frameToMark:()=>{
      seek(currentTime());
      return time<second.duration?frameAt(second.times,time):null;
    }};
  }

  function table(headers, rows, sortable = false) {
    const head = element('thead'), row = element('tr');
    const columns = headers.map(h => element('th',h,{scope:'col'}));
    row.append(...columns);
    head.append(row);
    const body = element('tbody');
    const rowNodes = rows.map(values => {
      const tr = element('tr');
      for (const item of values) {
        const td = element('td');
        td.append(item);
        tr.append(td);
      }
      return tr;
    });
    body.append(...rowNodes);
    if (sortable) {
      const indicators = columns.map((column, index) => {
        const control = btn(headers[index], () => {
          const descending = generationSort?.column === index && !generationSort.descending;
          generationSort = {column:index, descending};
          applySort();
        }, {className:'job-sort', 'data-sort-column':index});
        const indicator = element('span','↕',{'aria-hidden':'true'});
        control.append(indicator);
        column.replaceChildren(control);
        return indicator;
      });
      function applySort() {
        if (!generationSort || generationSort.column >= columns.length) return;
        const {column, descending} = generationSort;
        columns.forEach((heading, index) => {
          if (index === column) heading.setAttribute('aria-sort',descending ? 'descending' : 'ascending');
          else heading.removeAttribute('aria-sort');
          indicators[index].textContent = index === column ? (descending ? '↓' : '↑') : '↕';
        });
        const direction = descending ? -1 : 1;
        body.replaceChildren(...rowNodes.toSorted((a,b) => direction *
          jobCollator.compare(a.cells[column].textContent,b.cells[column].textContent)));
      }
      applySort();
    }
    const node = element('table');
    node.append(head,body);
    return container('workflow-table',node);
  }

  function generationTransport(view, media, label, url) {
    const seekBar=element('input',null,{type:'range',min:0,step:.01,value:0,disabled:true,
      'aria-label':'Seek '+label,oninput:event=>{media.currentTime=Number(event.target.value);}});
    const time=element('output',null,{className:'media-time'});
    const playback=evaluationAction('play','Play '+label,async()=>{
      if (!media.paused) media.pause();
      else {
        try {await media.play();}
        catch(error) {notice('Playback failed. '+error.message,true);}
      }
    });
    const audio=evaluationAction('audioOn','Mute '+label,()=>{media.muted=!media.muted;});
    const fullscreen=evaluationAction('fullscreen','Toggle fullscreen for '+label,async()=>{
      try {
        if (document.fullscreenElement===view) await document.exitFullscreen();
        else await view.requestFullscreen();
      } catch (error) {notice('Fullscreen unavailable. '+error.message,true);}
    });
    fullscreen.hidden=!(document.fullscreenEnabled&&view.requestFullscreen);
    const volume=element('input',null,{type:'range',min:0,max:1,step:.05,value:1,
      'aria-label':'Volume for '+label,oninput:event=>{
        media.volume=Number(event.target.value);
        media.muted=false;
      }});
    const speed=createPicker('Playback speed',[.5,1,1.25,1.5,2].map(value=>({value,label:value+'×'})),1,
      value=>{media.playbackRate=value;},{minWidth:112});
    const options=element('details',null,{className:'media-options runway-disclosure'});
    const volumeRow=container('media-volume',element('span','Volume',{className:'muted'}),volume);
    options.append(element('summary','Playback options'),volumeRow,
      container('media-option-actions',speed.view,element('a','Download video',{href:url,download:''})));
    const stamp=seconds=>Math.floor(seconds/60)+':'+String(Math.floor(seconds%60)).padStart(2,'0');
    function syncTime() {
      const duration=Number.isFinite(media.duration)?media.duration:0;
      seekBar.max=duration;
      seekBar.disabled=!duration;
      seekBar.value=media.currentTime;
      time.textContent=stamp(media.currentTime)+' / '+stamp(duration);
    }
    function syncPlayback() {
      updateIcon(playback,media.paused?'play':'pause',(media.paused?'Play ':'Pause ')+label);
    }
    for (const event of ['loadedmetadata','durationchange','timeupdate','seeked']) media.addEventListener(event,syncTime);
    for (const event of ['play','pause','ended']) media.addEventListener(event,syncPlayback);
    media.addEventListener('volumechange',()=>{
      volume.value=media.volume;
      updateIcon(audio,media.muted||!media.volume?'audioOff':'audioOn',(media.muted?'Unmute ':'Mute ')+label);
    });
    syncTime();
    return container('generation-controls',seekBar,container('generation-playback',playback,audio,time,fullscreen),options);
  }

  function player(label, url, poster = url+'?poster=1', showHeading = true, withControls = false) {
    const media = element('video',null,{src:url,poster,preload:'metadata',playsInline:true,'aria-label':label});
    const view = container('review-player');
    if (showHeading) view.append(element('h3',label));
    view.append(media);
    if (withControls) view.append(generationTransport(view,media,label,url));
    return {view,media};
  }

  function meter(label, value, total, tone = '') {
    const bar = element('progress', null, {value, max:Math.max(total,1),
      'aria-label':label, 'aria-valuetext':value+' of '+total});
    return container('progress-meter '+tone,
      container('progress-caption',element('span',label),element('strong',value+' / '+total)),bar);
  }

  function datasetProgress(info, data) {
    const approved = data.clips.filter(c=>c.approved).length;
    const jobs = data.clips.flatMap(c=>c.jobs);
    const card = container('dataset-progress-card',element('h3',info.name),
      meter('Clips approved',approved,data.clips.length));
    if (Object.keys(data.models).length) {
      card.append(meter('Videos ready',jobs.filter(j=>j==='succeeded').length,jobs.length,'ready-meter'));
    }
    return card;
  }

  async function queueApproved(dataset, clips, button, token) {
    if (queueingDatasets.has(dataset)) return;
    queueingDatasets.add(dataset);
    button.disabled = true;
    notice('Queuing generation for approved clips…');
    let accepted = 0;
    const failures = [];
    for (const clip of clips) {
      try {
        await fetchJson('./api/'+dataset+'/generation/'+clip.id,request('POST',{}));
        accepted++;
      } catch (error) {
        failures.push(clip.title+' — '+error.message);
      }
    }
    queueingDatasets.delete(dataset);
    if (token !== version) return;
    if (failures.length) {
      notice('Accepted '+accepted+' of '+clips.length+' generation requests. '+failures[0],true);
    } else {
      notice('Generation queued for '+accepted+(accepted===1?' approved clip.':' approved clips.'));
    }
    await generationList(token);
  }

  async function generationList(token) {
    clearTimeout(refresh);
    const read = ++generationRead;
    try {
      const active = getDataset();
      const info = getDatasets().find(dataset=>dataset.id===active);
      const data = await fetchJson(path('generation'));
      if (token !== version || read !== generationRead) return;
      const headings = Object.values(data.models).flatMap(name=>data.variants.map(v=>name+' · '+variantLabels[v]));
      const rows = data.clips.map(c=>[btn(c.title,()=>openGeneration(c)),c.approved?'Approved':'Needs approval',
        ...c.jobs.map(status)]);
      const progress = datasetProgress(info,data);
      const eligible = data.clips.filter(c=>c.approved && c.jobs.includes('not_started'));
      const previousButton = root.querySelector('.generate-all');
      const button = btn('Generate All Approved',()=>queueApproved(active,eligible,button,token),{
        className:'primary generate-all',disabled:!data.configured || !eligible.length || queueingDatasets.has(active),
        title:'Generate missing videos for approved clips in '+info.name
      });
      const heading = container('workflow-heading generation-heading',element('h1','Generation'));
      if (!readOnly) heading.append(button);
      if (!headings.length) {
        root.replaceChildren(heading,progress,element('p',noModels,{className:'muted'}));
        return;
      }
      const previousTable = root.querySelector('.workflow-table');
      const horizontalScroll = previousTable?.scrollLeft ?? 0;
      const focused = document.activeElement;
      const sortFocus = previousTable?.contains(focused) && focused.dataset.sortColumn;
      const jobsTable = table(['Clip','Approval',...headings],rows,true);
      root.replaceChildren(heading,progress,element('h2',info.name+' generation jobs',{className:'job-list-title'}),
        jobsTable);
      jobsTable.scrollLeft = horizontalScroll;
      if (previousButton === focused) button.focus({preventScroll:true});
      if (sortFocus) jobsTable.querySelector(`[data-sort-column="${sortFocus}"]`)?.focus({preventScroll:true});
      if (!readOnly) refresh = setTimeout(()=>generationList(token),6000);
    } catch (error) {
      if (token === version && read === generationRead) {
        fail(error,token);
        if (!readOnly) refresh = setTimeout(()=>generationList(token),6000);
      }
    }
  }

  function openGeneration(clip) {
    if (generationClip===clip.id) return;
    close();
    generationClip=clip.id;
    onGenerationSelection();
    const token = version;
    let current, renderedModels, reveal = false, queueing = false;
    const slots = new Map();
    const header = title(clip.title);
    const details = container('generation-actions');
    const jobProgress = container('job-progress');
    const players = container('job-matrix');
    const toggle = element('input',null,{type:'checkbox',role:'switch',onchange:event=>{
      reveal=event.target.checked;
      renderJobs();
    }});
    const toggleLabel = element('label','Show generated videos',{className:'output-toggle'});
    toggleLabel.prepend(toggle);
    const original = player('Original',path('clip/'+clip.id+'/media'),path('clip/'+clip.id+'/frame?n=0'),false,true);
    root.append(returnTo('generation','All generation jobs'),header,jobProgress,
      container('job-toolbar',details,toggleLabel),container('job-matrix-scroll',players));
    const resource = 'generation/'+clip.id;

    function initMatrix(models) {
      players.querySelectorAll('video').forEach(media=>media.pause());
      players.replaceChildren();
      slots.clear();
      players.style.setProperty('--job-columns', 1 + Object.keys(models).length);
      players.append(element('h2','Original',{className:'job-column-title'}));
      for (const name of Object.values(models)) players.append(element('h2',name,{className:'job-column-title'}));
      players.append(container('job-original',original.view));
      for (const variant of variantOrder) {
        for (const [model,name] of Object.entries(models)) {
          const controls=container('job-slot-status');
          const media=container('job-slot-media');
          const cell=container('job-slot',element('h3',variantLabels[variant]),controls,media);
          cell.setAttribute('aria-label',name+' · '+variantLabels[variant]);
          players.append(cell);
          slots.set(model+'/'+variant,{model,variant,controls,media,name});
        }
      }
    }
    function renderJobs() {
      if (!current) return;
      for (const slot of slots.values()) {
        const job=current.jobs.find(item=>item.model===slot.model&&item.variant===slot.variant);
        slot.controls.replaceChildren(status(job?.status??'not_started'));
        if (job?.error) slot.controls.append(element('p',job.error,{className:'muted'}));
        if (!readOnly && retryable.has(job?.status)) {
          slot.controls.append(btn('Retry',()=>queue(job),{disabled:!current.configured||queueing}));
        }
        const ready=job?.status==='succeeded';
        const key=reveal&&ready?current.revision+'/'+job.id:null;
        if (slot.key===key && slot.hidden===(!reveal&&ready)) continue;
        slot.media.querySelector('video')?.pause();
        slot.media.replaceChildren();
        if (key) {
          slot.media.append(player(slot.name+' · '+variantLabels[slot.variant],path(resource+'/media/'+key),undefined,false,true).view);
        } else if (ready) {
          slot.media.append(element('p','Video hidden',{className:'muted hidden-output'}));
        }
        slot.key=key;
        slot.hidden=!reveal&&ready;
      }
    }
    async function queue(job) {
      if (queueing) return;
      queueing=true;
      try {
        await fetchJson(path(resource),request('POST',job?{job:job.id}:{}));
        if (token===version) {clearTimeout(refresh); await update();}
      } catch (error) {fail(error,token);}
      finally {queueing=false;if(token===version) renderJobs();}
    }
    async function update() {
      try {
        const data = await fetchJson(path(resource));
        if (token!==version) return;
        current=data;
        const modelIds = Object.keys(data.models).join(',');
        if (modelIds !== renderedModels) {
          initMatrix(data.models);
          renderedModels = modelIds;
        }
        const approval = data.approved ? 'Approved labels · revision '+data.revision : 'Needs approval in Labeling';
        const completed=data.jobs.filter(job=>job.status==='succeeded').length;
        const pending=data.jobs.filter(job=>inProgress.has(job.status)).length;
        const blocked=data.jobs.length-completed-pending;
        const counts = [pending&&pending+' in progress',blocked&&blocked+' need attention'].filter(Boolean).join(' · ');
        jobProgress.replaceChildren(element('p',counts?approval+' · '+counts:approval,{className:'muted'}));
        if (data.total) jobProgress.prepend(meter('Videos ready',completed,data.total,'ready-meter'));
        toggleLabel.hidden = !data.total;
        details.replaceChildren();
        const missing = data.total - data.jobs.length;
        if (!data.total) {
          details.append(element('p',noModels,{className:'muted'}));
        } else if (missing && !readOnly) {
          details.append(btn('Generate '+missing+(missing===1?' video':' videos'),()=>queue(),
            {className:'primary',disabled:!data.approved||!data.configured||queueing}));
          if (!data.configured) details.append(element('p','Runway is not configured on this server.',{className:'muted'}));
        }
        renderJobs();
        if (!readOnly && data.jobs.some(j=>inProgress.has(j.status))) refresh=setTimeout(update,6000);
      } catch (error) {fail(error,token);}
    }
    update();
  }

  async function evaluationList(token) {
    try {
      const data = await fetchJson(path('evaluation'));
      if (token!==version) return;
      if (!Object.keys(data.models).length) {
        root.replaceChildren(title('Evaluation Jobs',noModels));
        return;
      }
      const rows = data.clips.map(clip=>{
        const submissions=clip.submissions??[];
        const actions=container('evaluation-list-actions');
        if (!readOnly&&clip.ready&&!clip.evaluated) actions.append(btn('Begin blind evaluation',()=>openEvaluation(clip)));
        for (const submission of submissions) {
          const label=submissions.length===1?'View evaluation':
            'View revision '+submission.revision+' · '+new Date(submission.submitted_at).toLocaleString();
          actions.append(btn(label,()=>openEvaluation(clip,submission)));
        }
        const status=clip.evaluated?'Submitted':clip.ready?'Ready':
          clip.no_successful_outputs?'No successful outputs':
          submissions.length?'Earlier evaluation submitted':'Waiting for enabled outputs';
        return [clip.title,status,actions];
      });
      root.replaceChildren(title('Evaluation Jobs','Mark when each prompted shot begins in the shuffled videos.'),
        table(['Clip','Evaluation',''],rows));
    } catch (error) {fail(error,token);}
  }

  async function evaluationOverview(token) {
    try {
      const data = await fetchJson(path('evaluation/results'));
      if (token!==version) return;
      root.replaceChildren(title('Overview',data.submitted+' submitted clip evaluations'),overviewResults(data.groups));
    } catch (error) {fail(error,token);}
  }

  function overviewResults(results) {
    const percent=(value,total)=>total?100*value/total:0;
    const percentage=(value,total)=>Math.round(percent(value,total))+'%';
    const format=(value,total)=>total?value+' / '+total+' ('+percentage(value,total)+')':'—';
    const chartLegend=(title,bands)=>{
      const legend=container('timing-legend',...bands.map(({label,tone})=>
        container('timing-legend-item',element('span',null,{className:'timing-band '+tone,'aria-hidden':'true'}),
          element('span',label))));
      legend.setAttribute('aria-label',title);
      legend.setAttribute('role','group');
      return legend;
    };
    const excludeOpening=element('input',null,{type:'checkbox',role:'switch',onchange:()=>{
      updateShotTable();
      updateCharts();
    }});
    const openingControl=element('label','Exclude openings',{className:'output-toggle'});
    openingControl.prepend(excludeOpening);
    const selectedEvents=result=>excludeOpening.checked?result.events_without_opening:result.events;
    const distributionPlot=container('evaluation-distribution');
    const comparisonPlot=container('evaluation-comparison');
    const signedDistributionPlot=container('evaluation-distribution');
    const signedComparisonPlot=container('evaluation-comparison');
    const durationPlot=container('evaluation-comparison');
    const statistics=container('evaluation-statistics');
    const compareOrder=createPicker('Sort comparison',[
      {value:'table',label:'Table order'},
      {value:'tight',label:'Highest ±0.100 s rate'},
      {value:'outside',label:'Highest outside rate'},
      {value:'volume',label:'Most shots'}
    ],'table',()=>updateCharts(),{minWidth:205});
    const charts=container('evaluation-charts',
      container('evaluation-chart',element('h2','Shot boundary breakdown'),distributionPlot),
      container('evaluation-chart',container('evaluation-chart-heading',element('h2','Shot boundary ranges (by model)'),compareOrder.view),
        comparisonPlot),
      container('evaluation-chart statistics-card',element('h2','Shot boundary statistics'),statistics)
    );
    const signedSection=element('section',null,{className:'signed-error-section','aria-labelledby':'signed-error-title'});
    signedSection.append(
      element('h2','Signed shot boundary error',{id:'signed-error-title'}),
      element('p','Generated timestamp minus ground truth. Negative errors indicate earlier cuts.',
        {className:'muted signed-error-caption'}),
      chartLegend('Signed shot boundary ranges',signedTimingBands),
      container('evaluation-charts',
        container('evaluation-chart',element('h3','Signed boundary breakdown'),signedDistributionPlot),
        container('evaluation-chart',element('h3','Signed boundary ranges (by model)'),signedComparisonPlot),
        container('evaluation-chart duration-chart',element('h3','Shot duration error',
          {title:'Measured between consecutive cuts. The final shot ends at the end of each video.'}),
          chartLegend('Shot duration error ranges',shotDurationBands),durationPlot))
    );
    const selection=element('input',null,{type:'checkbox',className:'overview-checkbox',checked:true,
      'aria-label':'Select all result rows',onchange:()=>{
        for (const {children} of models) children.forEach(child=>{child.checkbox.checked=selection.checked;});
        updateCharts();
      }});
    const metricGroups=[
      {label:'Total Video Duration',columns:['±0.100 s','±0.300 s']},
      {label:'Shot Boundaries',columns:['Exact','±0.100 s','±0.300 s','Outside ±0.300 s']}
    ];
    const header=element('tr');
    const selectHeader=element('th',null,{scope:'col',rowSpan:2,className:'overview-select-cell'});
    selectHeader.append(selection);
    header.append(selectHeader,element('th','Model / input',{scope:'col',rowSpan:2}));
    const ranges=element('tr');
    for (const {label,columns} of metricGroups) {
      header.append(element('th',label,{scope:'colgroup',colSpan:columns.length,
        className:'overview-metric-group overview-metric-start'}));
      columns.forEach((name,index)=>ranges.append(element('th',name,
        {scope:'col',className:index===0?'overview-metric-start':''})));
    }
    const head=element('thead');
    head.append(header,ranges);
    const resultsTable=element('table');
    const shotRows=[];
    resultsTable.append(element('colgroup',null,{span:2}),
      ...metricGroups.map(group=>element('colgroup',null,{span:group.columns.length})),head);
    const models=results.filter(result=>!result.variant).map((total,modelIndex)=>{
      const group=element('tbody');
      const checkbox=element('input',null,{type:'checkbox',className:'overview-checkbox',checked:true,
        'aria-label':'Select '+total.model+' (Total)',onchange:()=>{
          children.forEach(child=>{child.checkbox.checked=checkbox.checked;});
          updateCharts();
        }});
      const children=results.filter(result=>result.model===total.model&&result.variant).map((result,index)=>{
        const label=variantLabels[result.variant];
        const checkbox=element('input',null,{type:'checkbox',className:'overview-checkbox',checked:true,
          'aria-label':'Select '+total.model+' · '+label,onchange:updateCharts});
        const row=overviewRow(result,checkbox,element('span',label),'overview-variant-row');
        row.id='overview-variant-'+modelIndex+'-'+index;
        return {result,checkbox,row};
      });
      const toggle=btn(null,()=>{
        const expanded=toggle.getAttribute('aria-expanded')==='true';
        toggle.setAttribute('aria-expanded',String(!expanded));
        children.forEach(child=>{child.row.hidden=expanded;});
      },{className:'overview-model-toggle','aria-expanded':'true','aria-controls':children.map(child=>child.row.id).join(' ')});
      toggle.append(element('span',null,{className:'overview-chevron','aria-hidden':'true'}),
        element('span',total.model+' (Total)'));
      group.append(overviewRow(total,checkbox,toggle,'overview-model-row'),...children.map(child=>child.row));
      resultsTable.append(group);
      return {total,checkbox,children};
    });
    selection.disabled=!models.length;
    updateShotTable();
    updateCharts();
    return container('evaluation-overview',
      container('overview-chart-toolbar',chartLegend('Shot boundary ranges',timingBands),openingControl),charts,signedSection,
      element('p','The absolute charts and table use exact frame matches and count absent shots as outside. The table’s ±0.300 s cutoff includes ±0.100 s.',
        {className:'muted results-note'}),
      container('workflow-table overview-table',resultsTable));

    function overviewRow(result, checkbox, label, className) {
      const row=element('tr',null,{className});
      const checkCell=element('td');
      checkCell.append(checkbox);
      const name=element('th',null,{scope:'row'});
      name.append(label);
      row.append(checkCell,name);
      const {duration}=result;
      row.append(element('td',format(duration.within_100ms,duration.count),{className:'overview-metric-start'}),
        element('td',format(duration.within_300ms,duration.count)));
      const cells=metricGroups[1].columns.map((_,index)=>element('td',null,{className:index===0?'overview-metric-start':''}));
      row.append(...cells);
      shotRows.push({result,cells});
      return row;
    }
    function updateShotTable() {
      for (const {result,cells} of shotRows) {
        const events=selectedEvents(result);
        const scores=[events.exact,events.within_100ms,events.within_300ms,events.count-events.within_300ms];
        cells.forEach((cell,index)=>{cell.textContent=format(scores[index],events.count);});
      }
    }
    function updateCharts() {
      const comparison=[];
      const errors=[];
      let selectedCount=0, available=0;
      const chartBands={bands:timingBands,signed_bands:signedTimingBands,duration_bands:shotDurationBands};
      for (const model of models) {
        const checked=model.children.filter(child=>child.checkbox.checked);
        available+=model.children.length;
        selectedCount+=checked.length;
        model.checkbox.checked=checked.length>0&&checked.length===model.children.length;
        model.checkbox.indeterminate=checked.length>0&&!model.checkbox.checked;
        const events={count:0,within_100ms:0,within_300ms:0};
        for (const [key,bands] of Object.entries(chartBands)) {
          events[key]=Object.fromEntries(bands.map(({tone})=>[tone,0]));
        }
        for (const child of checked) {
          const selected=selectedEvents(child.result);
          events.count+=selected.count;
          events.within_100ms+=selected.within_100ms;
          events.within_300ms+=selected.within_300ms;
          for (const [key,bands] of Object.entries(chartBands)) {
            for (const {tone} of bands) events[key][tone]+=selected[key][tone];
          }
          errors.push(...selected.absolute_errors);
        }
        if (checked.length) comparison.push({model:model.total.model,events});
      }
      selection.checked=available>0&&selectedCount===available;
      selection.indeterminate=selectedCount>0&&!selection.checked;
      const totals=key=>chartBands[key].map(({tone})=>comparison.reduce((sum,{events})=>sum+events[key][tone],0));
      const shots=comparison.reduce((sum,{events})=>sum+events.count,0);
      const summary=shots?shots+' scored shots across '+selectedCount+(selectedCount===1?' selected variant':' selected variants'):
        (selectedCount?'No scored shots in the selected rows.':'Select rows to chart their shots.');
      const ranking={
        tight:events=>events.count?percent(events.within_100ms,events.count):-1,
        outside:events=>events.count?percent(events.count-events.within_300ms,events.count):-1,
        volume:events=>events.count
      }[compareOrder.value];
      if (ranking) comparison.sort((a,b)=>ranking(b.events)-ranking(a.events));
      renderDistribution(distributionPlot,timingBands,totals('bands'),summary);
      renderComparison(comparisonPlot,timingBands,comparison,'bands');
      renderDistribution(signedDistributionPlot,signedTimingBands,totals('signed_bands'),summary);
      renderComparison(signedComparisonPlot,signedTimingBands,comparison,'signed_bands');
      renderComparison(durationPlot,shotDurationBands,comparison,'duration_bands');
      renderStatistics(errors);
    }
    function renderDistribution(plot,bands,totals,summary) {
      const total=totals.reduce((sum,count)=>sum+count,0);
      if (!total) {
        plot.replaceChildren(element('p',summary,{className:'muted chart-empty'}));
        return;
      }
      const description=bands.map(({label},index)=>label+': '+format(totals[index],total)).join(' · ');
      const pie=element('div',null,{className:'distribution-pie',role:'img',tabIndex:0,
        'aria-label':description,title:description});
      const stops=[];
      let offset=0;
      bands.forEach(({tone},index)=>{
        const share=percent(totals[index],total);
        if (!share) return;
        const end=offset+share;
        const color='var(--timing-'+tone+')';
        stops.push(color+' '+offset+'%',color+' '+end+'%');
        if (share>=8) {
          const angle=(offset+share/2)*Math.PI/50;
          const label=element('span',percentage(totals[index],total),{className:tone,'aria-hidden':'true'});
          label.style.left=50+Math.sin(angle)*32+'%';
          label.style.top=50-Math.cos(angle)*32+'%';
          pie.append(label);
        }
        offset=end;
      });
      pie.style.backgroundImage='conic-gradient('+stops.join(',')+')';
      plot.replaceChildren(pie,element('p',summary,{className:'muted'}));
    }
    function renderComparison(plot,bands,rows,key) {
      const duration=key==='duration_bands';
      if (!rows.length) {
        plot.replaceChildren(element('p',duration?'Select rows to compare shot durations.':'Select rows to compare timing.',
          {className:'muted chart-empty'}));
        return;
      }
      const bars=rows.map(result=>{
        const {events}=result;
        const count=bands.reduce((sum,{tone})=>sum+events[key][tone],0);
        const details=container('chart-row-label',element('span',result.model),
          element('span',count+(duration?' measured':' shots'),{className:'muted'}));
        const row=container('comparison-row',details);
        const segments=bands.flatMap(({label,tone})=>{
          const value=events[key][tone];
          if (!value) return [];
          const share=percent(value,count);
          const description=label+': '+format(value,count);
          const part=element('span',share>=14?percentage(value,count):null,
            {className:'timing-band '+tone,title:description,role:'img','aria-label':description,tabIndex:0});
          part.style.width=share+'%';
          return [part];
        });
        row.append(count?container('comparison-track',...segments):
          element('p',duration?'No measurable shots':'No scored shots',{className:'muted'}));
        if (duration && count<events.count) row.append(element('p',(events.count-count)+' unmeasurable',
          {className:'muted'}));
        return row;
      });
      plot.replaceChildren(...bars);
    }
    function renderStatistics(errors) {
      const count=errors.length;
      const sorted=errors.sort((a,b)=>a-b);
      const mean=count?sorted.reduce((sum,error)=>sum+error,0)/count:0;
      const mid=Math.floor(count/2);
      const median=count?(sorted[mid]+sorted[Math.floor((count-1)/2)])/2:0;
      const deviation=count?Math.sqrt(sorted.reduce((sum,error)=>sum+(error-mean)**2,0)/count):0;
      const values=element('dl',null,{className:'statistics-values'});
      for (const [label,value] of [['Mean',mean],['Median',median],['Standard deviation',deviation]]) {
        const term=element('dt',label,label==='Standard deviation'?{title:'Population standard deviation'}:{});
        values.append(container('statistics-row',term,element('dd',count?value.toFixed(3)+' s':'—')));
      }
      statistics.replaceChildren(values,element('p',count+' timed '+(count===1?'shot':'shots')+
        ' · Absolute error. Absent shots excluded.',{className:'muted'}));
    }
  }

  async function openEvaluation(clip, submission) {
    if (readOnly && !submission) return;
    close();
    const token=version, resource='evaluation/'+clip.id;
    const query=submission?'?'+new URLSearchParams({submission:submission.id}):'';
    root.append(returnTo('evaluation','All evaluations'),
      title(clip.title,submission?'Loading submitted evaluation…':'Preparing blind evaluation…'));
    let data;
    try {
      data=submission
        ? await fetchJson(path(resource+'/submitted/'+submission.revision)+query)
        : await fetchJson(path(resource+'/start'),request('POST',{}));
    }
    catch(error) {fail(error,token);return;}
    if (token!==version) return;
    let selected=0, eventIndex=0, candidateFramePresent=false, sealing=false;
    const events=data.events;
    const marks = submission?data.marks:Object.fromEntries(data.candidates.map(c=>[c.id,Array(events.length)]));
    const candidateUrl=(action,candidate)=>path(resource+'/'+action+'/'+data.revision+'/'+candidate.id)+query;
    const original = player('Original',path('clip/'+clip.id+'/media'),path('clip/'+clip.id+'/frame?n=0'));
    const candidatePanel=container('candidate-panel');
    const candidatePicker=createPicker('Candidate',[],0,index=>{
        selectCandidate(index);
        renderSteps();
      });
    const eventList=container('event-list');
    const promptPanel=element('details',null,{className:'evaluation-prompt runway-disclosure'});
    const promptCandidate=element('span',null,{className:'evaluation-prompt-candidate'});
    const promptSummary=element('summary','Generation prompt');
    const promptBody=container('evaluation-prompt-body');
    promptSummary.append(' ',promptCandidate);
    promptPanel.append(promptSummary,promptBody);
    promptPanel.addEventListener('toggle',loadPrompt);
    let promptRead;
    const eventProgress=element('span',null,{className:'muted'});
    const eventStatus=element('p',null,{className:'muted',role:'status'});
    const submissionProgress=element('p',null,{className:'muted evaluation-progress'});
    const complete = (id) => marks[id].filter(n=>n!==undefined).length;
    const active = () => data.candidates[selected];
    const shotTime=(index)=>events[index].frame/data.fps;
    const originalShots=events.map((event,index)=>({index,title:event.title,start:shotTime(index),
      end:index+1<events.length?shotTime(index+1):data.source.duration}));
    const transport=comparisonTransport(data.source,original,originalShots,data.fps,present=>{
      candidateFramePresent=present;
      if (markFrame) markFrame.disabled=sealing||!present;
    },index=>moveToEvent(index,false));
    stopEvaluation=()=>{
      transport.stop();
      promptRead?.abort();
    };
    async function loadPrompt() {
      promptRead?.abort();
      const candidate=active();
      promptCandidate.textContent=candidate.label;
      if (!promptPanel.open || token!==version) {
        promptBody.replaceChildren();
        return;
      }
      const read=new AbortController();
      promptRead=read;
      promptBody.replaceChildren(element('p','Loading generation prompt…',{className:'muted',role:'status'}));
      try {
        const submitted=await fetchJson(candidateUrl('prompt',candidate),{signal:read.signal});
        if (read.signal.aborted || token!==version || !promptPanel.open) return;
        const text=element('pre',submitted.text,{className:'evaluation-prompt-text',tabIndex:0,'aria-label':'Submitted prompt text'});
        const references=element('ol',null,{className:'evaluation-prompt-references'});
        submitted.references.forEach((uri,index)=>{
          const item=element('li');
          const label='Image '+(index+1);
          item.append(element('img',null,{src:uri,alt:'Reference '+label.toLowerCase(),loading:'lazy'}),
            element('span',label,{className:'muted'}));
          references.append(item);
        });
        promptBody.replaceChildren(text,element('h3','Reference images'),submitted.references.length
          ? references : element('p','No reference images were submitted.',{className:'muted'}));
      } catch (error) {
        if (!read.signal.aborted && token===version && promptPanel.open) {
          promptBody.replaceChildren(element('p','Generation prompt unavailable. '+error.message,{className:'muted',role:'status'}));
        }
      } finally {
        if (promptRead===read) promptRead=undefined;
      }
    }
    function renderCandidate() {
      const c=active();
      const url=candidateUrl('media',c);
      const playerView=player(c.label,url,url+(query?'&':'?')+'poster=1');
      const restoreFocus=document.activeElement===candidatePicker.trigger;
      transport.setCandidate(playerView,c);
      playerView.view.querySelector('h3').replaceWith(candidatePicker.view);
      candidatePanel.replaceChildren(playerView.view);
      if (restoreFocus) candidatePicker.trigger.focus({preventScroll:true});
      loadPrompt();
    }
    function moveToEvent(index, seek=true) {
      eventIndex=index;
      if (seek) transport.seek(shotTime(index));
      renderSteps();
    }
    function mark(value) {
      marks[active().id][eventIndex]=value;
      blindMarks=true;
      notice();
      moveToEvent(Math.min(eventIndex+1,events.length-1),false);
    }

    function selectCandidate(index) {
      if (selected===index) return;
      selected=index;
      renderCandidate();
    }
    const eventRows=events.map((event,index)=>{
      const row=btn(null,()=>moveToEvent(index),{className:'event-row'});
      const status=element('span',null,{className:'event-mark'});
      row.append(element('span',event.timecode,{className:'event-time'}),element('span',event.title),status);
      eventList.append(row);
      return {row,status};
    });
    const previousEvent=evaluationAction('previousEvent','Previous event',()=>moveToEvent(eventIndex-1));
    const nextEvent=evaluationAction('nextEvent','Next event',()=>moveToEvent(eventIndex+1));
    const seekEvent=evaluationAction('seekEvent','Seek both videos to shot',()=>transport.seek(shotTime(eventIndex)));
    const markAbsent=submission?null:evaluationAction('absent','Event absent',()=>mark(null));
    const markFrame=submission?null:evaluationAction('mark','Mark current frame',()=>{
      const frame=transport.frameToMark();
      if (frame!==null) mark(frame);
    },true);
    const submitAction=submission?null:evaluationAction('submit','Submit evaluation',submit);
    if (submitAction) {
      submitAction.classList.add('evaluation-submit-button');
      submitAction.append('Submit evaluation');
    }
    const mediaArea=container('evaluation-media',original.view,transport.view,candidatePanel);
    const actions=container('evaluation-actions',container('evaluation-action-group',previousEvent,nextEvent,seekEvent));
    if (!submission) actions.append(container('evaluation-action-group',markAbsent,markFrame));
    const timeline=container('evaluation-timeline',
      container('evaluation-timeline-heading',element('h2','Shot timeline'),eventProgress),eventList,eventStatus,
      actions,submissionProgress);
    timeline.setAttribute('role','region');
    timeline.setAttribute('aria-label','Shot timeline');
    const heading=container('workflow-heading evaluation-heading',element('h1',clip.title),
      submitAction??element('span','Submitted',{className:'job-status status-succeeded',
        title:new Date(data.submitted_at).toLocaleString()}));
    root.replaceChildren(returnTo('evaluation','All evaluations'),heading,
      container('evaluation-task',mediaArea,container('evaluation-inspector',timeline,promptPanel)));

    function renderSteps() {
      const candidate=active();
      const candidateMarks=marks[candidate.id];
      const candidateShots=candidateMarks.flatMap((frame,index)=>frame==null?[]:
        [{index,title:events[index].title,start:candidate.times[frame]}]).sort((a,b)=>a.start-b.start);
      transport.renderShots(candidateShots.map((shot,index)=>({...shot,
        end:candidateShots[index+1]?.start??candidate.duration})),eventIndex);
      candidatePicker.update(data.candidates.map((item,index)=>({value:index,
        label:item.label,description:complete(item.id)+' / '+events.length+' shots marked'})),selected);
      candidatePicker.setDisabled(sealing);
      eventRows.forEach(({row,status},index)=>{
        const value=candidateMarks[index];
        if (value===undefined) {
          status.textContent='';
          delete row.dataset.outcome;
        } else if (value===null) {
          status.textContent='Absent';
          row.dataset.outcome='miss';
        } else {
          const expected=shotTime(index);
          const observed=candidate.times[value];
          const offset=observed-expected;
          const error=Math.abs(offset);
          const precision=Number.EPSILON*Math.max(1,expected,observed);
          const exact=value===events[index].frame;
          row.dataset.outcome=exact?'exact':error<=.100+precision?'within-100ms':error<=.300+precision?'within-300ms':'miss';
          const sign=error<=precision?'':offset<0?'−':'+';
          const offsetLabel=sign+error.toFixed(3)+' s';
          status.textContent=exact?(error<=precision?'Exact':'Exact · '+offsetLabel):offsetLabel;
        }
        if (index===eventIndex) row.setAttribute('aria-current','step');
        else row.removeAttribute('aria-current');
      });
      const current=eventRows[eventIndex].row;
      const top=current.offsetTop;
      const bottom=top+current.offsetHeight;
      if (top<eventList.scrollTop) eventList.scrollTop=top;
      else if (bottom>eventList.scrollTop+eventList.clientHeight) eventList.scrollTop=bottom-eventList.clientHeight;
      const value=candidateMarks[eventIndex];
      eventProgress.textContent='Shot '+(eventIndex+1)+' of '+events.length;
      eventStatus.textContent=value===undefined?'Unmarked':value===null?'Marked as absent':'Marked at frame '+value;
      previousEvent.disabled=eventIndex===0;
      nextEvent.disabled=eventIndex===events.length-1;
      if (!submission) {
        markAbsent.disabled=sealing;
        markFrame.disabled=sealing||!candidateFramePresent;
        submitAction.disabled=sealing;
      }
      const marked=data.candidates.reduce((sum,item)=>sum+complete(item.id),0);
      const total=events.length*data.candidates.length;
      submissionProgress.textContent=marked+' / '+total+' marks';
    }
    async function submit() {
      if(sealing) return;
      const unfinished=data.candidates.findIndex(candidate=>complete(candidate.id)<events.length);
      if (unfinished!==-1) {
        selectCandidate(unfinished);
        const unmarked=marks[active().id].findIndex(value=>value===undefined);
        moveToEvent(unmarked);
        eventRows[unmarked].row.focus({preventScroll:true});
        notice('Mark the remaining shots for '+active().label+' before submitting.',true);
        return;
      }
      sealing=true;renderSteps();
      try {
        await fetchJson(path(resource+'/submit'),request('POST',{session:data.session,revision:data.revision,marks}));
        if(token===version) {blindMarks=false;show('evaluation');notice('Evaluation submitted.');}
      } catch(error) {sealing=false;renderSteps();fail(error,token);}
    }
    renderCandidate();renderSteps();
  }

  function show(mode, section = 'jobs') {
    close();
    const token=version;
    root.append(element('p','Loading…',{className:'muted'}));
    if (mode==='generation') generationList(token);
    if (mode==='evaluation') {
      onEvaluationSection(section);
      if (section==='overview') evaluationOverview(token);
      else evaluationList(token);
    }
  }
  return {show,close,canLeave,openGeneration,selectedGeneration:()=>generationClip,hasUnsaved:()=>blindMarks};
}

const $ = id => document.getElementById(id);
const video = $('video'), audio = $('music-audio');
const state = {token:'', ready:false, maxBytes:8*1024**3, video:null, music:null, start:0, end:0, importing:false, uploadRequest:null, exporting:false, job:null, polling:0, dragging:null, musicPlayPending:false, musicPreviewWarning:false};
const editable = ['play','set-in','set-out','scrub','in-handle','out-handle','trim-start','trim-end','video-volume','filename','quality','export'];
const musicControls = ['remove-music','music-volume','music-offset','loop-music','fade-in','fade-out'];
const clamp = (n,low,high) => Math.max(low,Math.min(high,n));
const clipDuration = () => Math.max(0,state.end-state.start);
const minimumClip = () => Math.min(state.video?.duration??0,Math.max(.05,1/(state.video?.fps||30)));
const busy = () => state.importing||state.exporting;

function time(value,precise=true){
  const milliseconds=Math.max(0,Math.round((Number.isFinite(value)?value:0)*1000));
  const hours=Math.floor(milliseconds/3600000),minutes=Math.floor(milliseconds/60000)%60,seconds=Math.floor(milliseconds/1000)%60;
  return `${hours?`${String(hours).padStart(2,'0')}:`:''}${String(minutes).padStart(2,'0')}:${String(seconds).padStart(2,'0')}${precise?`.${String(milliseconds%1000).padStart(3,'0')}`:''}`;
}
function parseTime(text){
  const parts=String(text).trim().replace(',','.').split(':');
  if(!parts.length||parts.length>3||parts.some(p=>!/^(?:\d+(?:\.\d*)?|\.\d+)$/.test(p)))return NaN;
  const values=parts.map(Number);if(values.some(n=>!Number.isFinite(n)))return NaN;
  if(values.length>1&&values.slice(1).some(n=>n>=60))return NaN;
  return values.reduce((result,value)=>result*60+value,0);
}
const numberValue = id => Number($(id).value)||0;
const offset = () => parseTime($('music-offset').value)||0;
function announce(text){$('announcement').textContent=text;}
function error(message){$('error-message').textContent=message;$('error').hidden=false;}
function clearError(){$('error').hidden=true;}
function markEdited(){if(state.job&&!state.exporting&&state.job.status==='complete'){$('job-title').textContent='Previous export';$('job-detail').textContent='This download is from your previous export. Export again to include these changes.';}}
async function releaseMedia(media){if(!media)return;try{await api(`/api/media/${encodeURIComponent(media.id)}`,{method:'DELETE'});}catch{error('The previous working copy could not be removed. Your original file is unchanged; you can keep editing.');}}
function errorText(body,fallback){return typeof body?.error==='string'?body.error:body?.error?.message||body?.message||fallback;}
async function api(path,options={}){
  const response=await fetch(path,{...options,headers:{...(options.body?{'Content-Type':'application/json'}:{}),...(options.method&&options.method!=='GET'?{'X-Editor-Token':state.token}:{}),...options.headers}});
  const body=await response.json().catch(()=>null);
  if(!response.ok){const cause=new Error(errorText(body,`The editor could not complete that request (${response.status}).`));cause.status=response.status;throw cause;}
  return body;
}

function updateDisabled(){
  const enabled=state.ready&&!busy(),hasVideo=!!state.video;
  $('open-video').disabled=$('choose-video').disabled=!enabled;
  $('add-music').disabled=!enabled||!hasVideo;
  for(const id of editable)$(id).disabled=!enabled||!hasVideo;
  $('video-volume').disabled=!enabled||!hasVideo||!state.video.hasAudio;
  for(const id of musicControls)$(id).disabled=!enabled||!state.music;
  $('timeline').classList.toggle('disabled',!enabled||!hasVideo);
  document.body.classList.toggle('busy',busy());
  $('export').hidden=state.exporting;
  $('preview-state').textContent=state.importing?'Importing':state.exporting?'Exporting':'Preview';
}
function updateVolume(){
  for(const kind of ['video','music']){
    const value=numberValue(`${kind}-volume`);
    $(`${kind}-volume-value`).value=`${Math.round(value*100)}%`;
    $(`${kind}-volume`).style.setProperty('--fill',`${value*100}%`);
  }
  video.volume=numberValue('video-volume');syncMusic(false);
}
function updateTrim(){
  const duration=state.video?.duration||1;
  $('trim-start').value=time(state.start);$('trim-end').value=time(state.end);
  $('clip-length').textContent=state.video?time(clipDuration()):'—';
  $('trim-window').style.left=`${state.start/duration*100}%`;$('trim-window').style.width=`${clipDuration()/duration*100}%`;
  for(const edge of ['in','out']){
    const handle=$(`${edge}-handle`),value=edge==='in'?state.start:state.end;
    handle.style.left=`${value/duration*100}%`;handle.setAttribute('aria-valuemin',String(edge==='in'?0:state.start+minimumClip()));
    handle.setAttribute('aria-valuemax',String(edge==='in'?Math.max(0,state.end-minimumClip()):duration));
    handle.setAttribute('aria-valuenow',String(value));handle.setAttribute('aria-valuetext',time(value));
  }
  $('export-length').textContent=state.video?`${time(clipDuration())} clip`:'Open a video to start';
  $('export-dimensions').textContent=state.video?`${state.video.width} × ${state.video.height}`:'MP4';
  for(const id of ['fade-in','fade-out']){const limit=Math.min(10,clipDuration());$(id).max=String(limit);if(numberValue(id)>limit)$(id).value=String(limit);}
  updateMusicHint();syncMusic(true);
}
function setTrim(edge,value){
  if(!state.video||busy()||!Number.isFinite(value))return;
  const gap=minimumClip();
  if(edge==='in')state.start=clamp(value,0,Math.max(0,state.end-gap));
  else state.end=clamp(value,Math.min(state.video.duration,state.start+gap),state.video.duration);
  markEdited();updateTrim();
  if(video.currentTime<state.start||video.currentTime>state.end)seek(edge==='in'?state.start:state.end);
}
function updateMusicHint(){
  if(!state.music)return;
  const remaining=Math.max(0,state.music.duration-offset());
  $('music-hint').textContent=$('loop-music').checked?'Starts at the chosen point, then loops the whole track.':remaining<clipDuration()?`Music ends ${time(remaining,false)} into the clip. The rest keeps your original audio.`:'Music begins with your trimmed clip.';
}
function seek(value){if(!state.video)return;video.currentTime=clamp(value,0,state.video.duration);updatePlayhead();syncMusic(true);}
function updatePlayhead(){
  $('current-time').textContent=time(video.currentTime);$('scrub').value=String(video.currentTime||0);$('scrub').setAttribute('aria-valuetext',time(video.currentTime));
}
function updatePlayButton(){
  const playing=!video.paused&&!video.ended;
  $('play').setAttribute('aria-label',playing?'Pause preview':'Play selection');$('play').querySelector('use').setAttribute('href',playing?'#i-pause':'#i-play');
}
function pause(){video.pause();audio.pause();updatePlayButton();}
async function togglePlay(){
  if(!state.video||busy())return;
  if(!video.paused){pause();return;}
  if(video.currentTime<state.start||video.currentTime>=state.end-.005)seek(state.start);
  state.musicPreviewWarning=false;
  try{const playback=video.play();syncMusic(true);await playback;}catch{error('This browser could not play the video. Try an MP4 video, or open the editor in Chrome or Edge.');}
  updatePlayButton();
}
function syncMusic(force){
  if(!state.music||!state.video){audio.pause();return;}
  const elapsed=video.currentTime-state.start,total=clipDuration(),trackDuration=state.music.duration,trackTime=offset()+Math.max(0,elapsed),loop=$('loop-music').checked;
  audio.loop=loop;
  const inSelection=elapsed>=-.02&&elapsed<total;
  const available=trackDuration>0&&(loop||trackTime<trackDuration);
  let gain=numberValue('music-volume');
  const fadeIn=numberValue('fade-in'),audibleEnd=loop?total:Math.min(total,Math.max(0,trackDuration-offset())),fadeOut=Math.min(numberValue('fade-out'),audibleEnd);
  if(fadeIn>0)gain*=clamp(elapsed/fadeIn,0,1);if(fadeOut>0)gain*=clamp((audibleEnd-elapsed)/fadeOut,0,1);
  audio.volume=clamp(gain,0,1);
  if(available){const wanted=loop?trackTime%trackDuration:trackTime;if((force||Math.abs(audio.currentTime-wanted)>.18)&&audio.readyState>0)audio.currentTime=clamp(wanted,0,trackDuration);}
  if(video.paused||!inSelection||!available||busy()){audio.pause();return;}
  if(audio.paused&&!state.musicPlayPending&&!state.musicPreviewWarning){state.musicPlayPending=true;audio.play().catch(()=>{if(!state.musicPreviewWarning){state.musicPreviewWarning=true;error('Music preview could not start. Pause and press Play again. Your export can still include the track.');}}).finally(()=>state.musicPlayPending=false);}
}
function frame(){
  if(state.video&&!video.paused){
    if(video.currentTime>=state.end){pause();seek(state.end);}
    else{updatePlayhead();syncMusic(false);}
  }
  requestAnimationFrame(frame);
}

function upload(file,kind){
  return new Promise((resolve,reject)=>{
    const xhr=new XMLHttpRequest();state.uploadRequest=xhr;xhr.open('POST',`/api/media?kind=${kind}&name=${encodeURIComponent(file.name)}`);
    xhr.setRequestHeader('X-Editor-Token',state.token);xhr.setRequestHeader('Content-Type','application/octet-stream');xhr.responseType='json';
    xhr.upload.onprogress=event=>{if(!event.lengthComputable)return;const fraction=event.loaded/event.total;$('upload-progress').value=fraction;$('upload-title').textContent=fraction>=1?'Reading file details…':`Opening ${kind==='video'?'video':'music'}…`;$('upload-detail').textContent=fraction>=1?'Checking duration and playback information':`${Math.round(fraction*100)}% copied to this computer’s editor`;};
    xhr.onload=()=>{if(xhr.status>=200&&xhr.status<300)resolve(xhr.response);else reject(new Error(errorText(xhr.response,`Could not open this file (${xhr.status}).`)));};
    xhr.onerror=()=>reject(new Error('The local editor is not responding. Keep its server running, then try opening the file again.'));
    xhr.onabort=()=>reject(new DOMException('Import cancelled.','AbortError'));xhr.send(file);
  });
}
async function importFile(file,kind){
  if(!file||!state.ready||busy()||(kind==='music'&&!state.video))return;
  if(file.size>state.maxBytes){error(`This file is too large. Choose a file under ${(state.maxBytes/1024**3).toFixed(0)} GB.`);return;}
  clearError();pause();state.importing=true;updateDisabled();$('upload-overlay').hidden=false;$('upload-progress').value=0;
  $('upload-title').textContent=`Opening ${kind==='video'?'video':'music'}…`;$('upload-detail').textContent='Copying to your local editor';
  try{
    const media=await upload(file,kind);
    if(!media?.id||!(media.duration>0)||!media.url)throw new Error('This file has no usable duration. Try another file.');
    if(kind==='video'){
      const old=state.video;state.video=media;state.start=0;state.end=media.duration;video.src=media.url;video.hidden=false;video.load();void releaseMedia(old);
      $('empty-preview').hidden=true;$('video-name').textContent=media.name;$('video-name').title=media.name;
      $('video-details').textContent=`${media.width} × ${media.height} · ${time(media.duration,false)}`;
      $('source-duration').textContent=time(media.duration);$('timeline-end').textContent=time(media.duration,false);$('scrub').max=String(media.duration);
      $('original-audio-hint').textContent=media.hasAudio?'Keep the sounds from your video, or turn them down.':'This video has no original audio.';
      updateTrim();
    }else{
      const old=state.music;state.music=media;state.musicPreviewWarning=false;audio.src=media.url;audio.load();void releaseMedia(old);$('music-name').textContent=media.name;$('music-name').title=media.name;$('music-duration').textContent=time(media.duration,false);
      $('music-offset').value=time(0);$('music-drop').hidden=true;$('music-file').hidden=false;$('music-settings').hidden=false;updateMusicHint();
    }
    markEdited();announce(`${media.name} is ready.`);
  }catch(cause){if(cause.name==='AbortError')announce('Import cancelled.');else error(cause.message||'The file could not be opened.');}
  finally{state.importing=false;state.uploadRequest=null;$('upload-overlay').hidden=true;updateDisabled();updateVolume();}
}
function removeMusic(){
  if(busy())return;audio.pause();audio.removeAttribute('src');audio.load();const old=state.music;state.music=null;state.musicPreviewWarning=false;void releaseMedia(old);markEdited();
  $('music-drop').hidden=false;$('music-file').hidden=true;$('music-settings').hidden=true;updateDisabled();announce('Music removed.');
}

function showJob(job){
  $('export-job').hidden=false;const progress=clamp(Number(job.progress)||0,0,1);$('export-progress').value=progress;$('job-percent').textContent=`${Math.floor(progress*100)}%`;
  if(job.status==='complete'){
    state.exporting=false;$('job-title').textContent='Your clip is ready';$('job-percent').textContent='100%';$('export-progress').value=1;
    $('job-detail').textContent='Saved by the local editor. Download your finished clip.';$('cancel-export').hidden=true;$('download').hidden=false;$('download').href=job.url;$('download').download=job.filename||'surf-clip.mp4';announce('Export complete. Your clip is ready to download.');
  }else if(job.status==='failed'||job.status==='cancelled'){
    state.exporting=false;$('job-title').textContent=job.status==='cancelled'?'Export cancelled':'Export did not finish';$('job-detail').textContent=job.status==='cancelled'?'Your edit is still here. You can export whenever you’re ready.':job.error||'Try again, or choose a different video.';$('cancel-export').hidden=true;$('download').hidden=true;
    if(job.status==='failed')error(job.error||'The video could not be exported.');announce($('job-title').textContent);
  }else{$('job-title').textContent=progress>0?'Creating your clip…':'Preparing your clip…';$('job-detail').textContent='Keep this page open. Your files stay on this computer.';}
  updateDisabled();
}
async function pollJob(){
  if(!state.job||!state.exporting)return;
  try{const job=await api(`/api/exports/${encodeURIComponent(state.job.id)}`);if(job.id!==state.job.id)return;state.job=job;showJob(job);}
  catch(cause){if(cause.status===404){showJob({status:'failed',progress:0,error:'This export is no longer available. Reload the editor and choose your files again.'});}else{$('job-title').textContent='Reconnecting to the editor…';$('job-detail').textContent='Keep the local editor running. Checking your export again shortly.';}}
  if(state.exporting)state.polling=setTimeout(pollJob,700);
}
async function exportClip(){
  if(!state.video||busy()||!state.ready)return;clearError();pause();
  state.exporting=true;state.job=null;updateDisabled();$('export-job').hidden=false;$('cancel-export').hidden=false;$('cancel-export').disabled=true;$('download').hidden=true;
  $('job-title').textContent='Preparing your clip…';$('job-detail').textContent='Starting your local export.';$('job-percent').textContent='0%';$('export-progress').value=0;
  const payload={videoId:state.video.id,musicId:state.music?.id??null,start:state.start,end:state.end,videoVolume:numberValue('video-volume'),musicVolume:numberValue('music-volume'),musicOffset:state.music?offset():0,fadeIn:state.music?numberValue('fade-in'):0,fadeOut:state.music?numberValue('fade-out'):0,loopMusic:$('loop-music').checked,quality:$('quality').value,filename:$('filename').value.trim().replace(/\.mp4$/i,'')||'surf-clip'};
  try{state.job=await api('/api/exports',{method:'POST',body:JSON.stringify(payload)});$('cancel-export').disabled=false;showJob(state.job);if(state.exporting)state.polling=setTimeout(pollJob,350);}
  catch(cause){state.exporting=false;showJob({status:'failed',progress:0,error:cause.message});}
}
async function cancelExport(){
  if(!state.job||!state.exporting)return;$('cancel-export').disabled=true;
  try{await api(`/api/exports/${encodeURIComponent(state.job.id)}`,{method:'DELETE'});clearTimeout(state.polling);await pollJob();}
  catch(cause){error(`Could not cancel yet. ${cause.message}`);}
  finally{$('cancel-export').disabled=false;}
}

function installDrop(target,kind){
  let depth=0;
  target.addEventListener('dragenter',event=>{if(!event.dataTransfer?.types.includes('Files'))return;event.preventDefault();depth++;if(state.ready&&!busy()&&(kind==='video'||state.video))target.classList.add('dragging');});
  target.addEventListener('dragover',event=>{event.preventDefault();if(event.dataTransfer)event.dataTransfer.dropEffect=busy()?'none':'copy';});
  target.addEventListener('dragleave',()=>{depth=Math.max(0,depth-1);if(!depth)target.classList.remove('dragging');});
  target.addEventListener('drop',event=>{event.preventDefault();event.stopPropagation();depth=0;target.classList.remove('dragging');const files=event.dataTransfer?.files;if(files?.length>1){error('Open one file at a time.');return;}void importFile(files?.[0],kind);});
}
installDrop($('video-drop'),'video');installDrop($('music-drop'),'music');
window.addEventListener('dragover',event=>{if(event.dataTransfer?.types.includes('Files'))event.preventDefault();});
window.addEventListener('drop',event=>{if(event.dataTransfer?.types.includes('Files'))event.preventDefault();});
for(const id of ['open-video','choose-video'])$(id).addEventListener('click',()=>$('video-file-input').click());
$('add-music').addEventListener('click',()=>$('music-file-input').click());
for(const kind of ['video','music'])$(`${kind}-file-input`).addEventListener('change',event=>{void importFile(event.target.files?.[0],kind);event.target.value='';});
$('remove-music').addEventListener('click',removeMusic);$('dismiss-error').addEventListener('click',clearError);
$('cancel-import').addEventListener('click',()=>state.uploadRequest?.abort());
$('play').addEventListener('click',togglePlay);$('video-drop').addEventListener('dblclick',()=>{if(state.video)void togglePlay();});
$('set-in').addEventListener('click',()=>setTrim('in',video.currentTime));$('set-out').addEventListener('click',()=>setTrim('out',video.currentTime));
$('scrub').addEventListener('input',()=>seek(numberValue('scrub')));
for(const [id,edge] of [['trim-start','in'],['trim-end','out']]){
  $(id).addEventListener('change',()=>{const value=parseTime($(id).value);if(!Number.isFinite(value)){error('Enter a time in seconds, or use minutes:seconds, such as 01:12.500.');updateTrim();return;}setTrim(edge,value);});
  $(id).addEventListener('keydown',event=>{if(event.key==='Enter')event.target.blur();});
}
for(const edge of ['in','out']){
  const handle=$(`${edge}-handle`);
  handle.addEventListener('pointerdown',event=>{if(handle.disabled||event.button!==0)return;event.preventDefault();handle.focus();pause();state.dragging=edge;handle.setPointerCapture(event.pointerId);});
  handle.addEventListener('pointermove',event=>{if(state.dragging!==edge||!handle.hasPointerCapture(event.pointerId))return;const box=$('timeline').getBoundingClientRect();setTrim(edge,(event.clientX-box.left)/box.width*state.video.duration);});
  handle.addEventListener('pointerup',event=>{if(handle.hasPointerCapture(event.pointerId))handle.releasePointerCapture(event.pointerId);state.dragging=null;announce(`${edge==='in'?'Start':'End'} ${time(edge==='in'?state.start:state.end)}.`);});
  handle.addEventListener('pointercancel',()=>state.dragging=null);
  handle.addEventListener('keydown',event=>{if(!state.video||busy())return;const value=edge==='in'?state.start:state.end,step=event.shiftKey?1:1/(state.video.fps||30);let next;
    if(event.key==='ArrowLeft'||event.key==='ArrowDown')next=value-step;else if(event.key==='ArrowRight'||event.key==='ArrowUp')next=value+step;else if(event.key==='Home')next=0;else if(event.key==='End')next=state.video.duration;else return;event.preventDefault();pause();setTrim(edge,next);
  });
}
$('music-offset').addEventListener('change',()=>{const value=parseTime($('music-offset').value);if(!Number.isFinite(value)){error('Enter a valid music start time, such as 00:12.500.');$('music-offset').value=time(0);}else $('music-offset').value=time(clamp(value,0,Math.max(0,Math.floor(((state.music?.duration||0)-.001)*1000)/1000)));syncMusic(true);updateMusicHint();});
for(const id of ['fade-in','fade-out'])$(id).addEventListener('change',()=>{$(id).value=String(clamp(numberValue(id),0,Math.min(10,clipDuration())));syncMusic(false);});
for(const id of ['video-volume','music-volume'])$(id).addEventListener('input',updateVolume);
$('loop-music').addEventListener('change',()=>{syncMusic(true);updateMusicHint();});
$('quality').addEventListener('change',()=>$('quality-hint').textContent=$('quality').value==='high'?'Clear image · larger download':'Smaller file · easier to share');
for(const id of ['filename','quality','video-volume','music-volume','music-offset','loop-music','fade-in','fade-out'])$(id).addEventListener('change',markEdited);
$('export').addEventListener('click',exportClip);$('cancel-export').addEventListener('click',cancelExport);
video.addEventListener('play',()=>{updatePlayButton();syncMusic(true);});video.addEventListener('pause',()=>{audio.pause();updatePlayButton();});
video.addEventListener('ended',pause);video.addEventListener('timeupdate',updatePlayhead);video.addEventListener('seeking',()=>syncMusic(true));
video.addEventListener('loadedmetadata',()=>{video.currentTime=state.start;updatePlayhead();});
video.addEventListener('error',()=>{if(state.video){pause();error('This video cannot be previewed in your browser. MP4 videos work best. You can still try exporting it, or open a different video.');}});
audio.addEventListener('loadedmetadata',()=>syncMusic(true));
audio.addEventListener('error',()=>{if(state.music)error('This track cannot be previewed in your browser. You can still try exporting it, or choose an MP3 or WAV track.');});
document.addEventListener('visibilitychange',()=>{if(document.hidden)pause();});
document.addEventListener('keydown',event=>{
  if(event.repeat||event.ctrlKey||event.altKey||event.metaKey||event.target.closest('input,textarea,select,[contenteditable="true"]')||!state.video||busy())return;
  if(event.code==='Space'&&!event.target.closest('button,a')){event.preventDefault();void togglePlay();}
  else if(event.code==='KeyI'){event.preventDefault();setTrim('in',video.currentTime);}
  else if(event.code==='KeyO'){event.preventDefault();setTrim('out',video.currentTime);}
});
async function connect(){
  try{const status=await api('/api/status');if(!status?.ready||!status.token)throw new Error('The local editor is not ready yet.');state.token=status.token;state.ready=true;state.maxBytes=status.limits?.maxBytes||state.maxBytes;$('connection-dot').className='status-dot ready';$('connection-status').textContent='Local editor ready';$('file-limit').textContent=`MP4 recommended · up to ${Math.round(state.maxBytes/1024**3)} GB`;$('connection-status').title='Files are copied only to this computer’s local editor.';updateDisabled();}
  catch(cause){$('connection-dot').className='status-dot offline';$('connection-status').textContent='Editor offline';error(`${cause.message} Start the local editor, then refresh this page.`);}
}
updateDisabled();updateTrim();updateVolume();requestAnimationFrame(frame);void connect();

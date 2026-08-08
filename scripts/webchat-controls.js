(function () {
  'use strict';
  // fleet-core: shared webchat CLIENT controls -- the model picker (web-aware collapse, DIRECT
  // Anthropic labels while web research is on), the web-research toggle + 8s sync poll, and the
  // auto-switch to a web-capable model. Single-sourced here so the agent chat pages can never
  // drift from each other again (they did: addMsg vs add). Vendored to scripts/ and served by
  // core webchat-ops.js at GET /core/webchat-controls.js. Each page boots it with its own
  // message renderer as the notify adapter:
  //   ChatControls.init({ notify: addMsg });   // keel
  //   ChatControls.init({ notify: add });      // castor
  // The header button keeps its inline onclick="toggleWeb()" -- provided as a global below.

  var MODELS = [], MODEL_ACTIVE = null, WEB_ON = false, webBusy = 0, PREV_SLUG = null;
  var notify = function () {};

  function webLabel(d){const m=String(d||'').match(/^claude-([a-z]+)-([0-9]+)-([0-9]+)/i);return m?('Claude '+m[1].charAt(0).toUpperCase()+m[1].slice(1)+' '+m[2]+'.'+m[3]):String(d||'');}

  function renderModelSel(){
    const bar=document.getElementById('modelbar'); if(!bar)return;
    if(!MODELS.length){bar.textContent='model: (unavailable)';return;}
    const list=WEB_ON?MODELS.filter(o=>o.web):MODELS;
    if(!list.length){bar.innerHTML='model: <span style="color:#f66">(no web-capable models configured)</span>';return;}
    let cur=MODEL_ACTIVE; if(!list.some(o=>o.slug===cur))cur=list[0].slug;
    let opts='';
    for(const o of list){opts+='<option value="'+o.slug+'"'+(o.slug===cur?' selected':'')+'>'+(WEB_ON?webLabel(o.webModel||o.slug):o.label)+'</option>';}
    bar.innerHTML='model: <select id="modelsel">'+opts+'</select>';
    wireModelSel();
  }
  function wireModelSel(){
    const sel=document.getElementById('modelsel'); if(!sel)return;
    sel.onchange=async()=>{
      const slug=sel.value;
      try{const r=await(await fetch('/model/select',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({slug:slug})})).json();
        if(r.ok){MODEL_ACTIVE=slug;notify('Model set to '+slug+' (applies to next message)','sys');}else{notify('Model change failed: '+(r.error||'unknown'),'err');}}
      catch(e){notify('Model change failed: '+e,'err');}
    };
  }
  async function ensureWebModel(){
    if(!WEB_ON)return;
    const list=MODELS.filter(o=>o.web);
    if(!list.length||list.some(o=>o.slug===MODEL_ACTIVE))return;
    const t=list[0];
    try{const r=await(await fetch('/model/select',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({slug:t.slug})})).json();
      if(r.ok){PREV_SLUG=MODEL_ACTIVE;MODEL_ACTIVE=t.slug;notify('Web research needs a web-capable model - switched to '+webLabel(t.webModel||t.slug),'sys');renderModelSel();}}catch(e){}
  }
  // Web turned OFF: restore the model that was active before the auto-switch (best effort).
  async function restorePrevModel(){
    if(WEB_ON||!PREV_SLUG||PREV_SLUG===MODEL_ACTIVE){PREV_SLUG=null;return;}
    const t=PREV_SLUG; PREV_SLUG=null;
    try{const r=await(await fetch('/model/select',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({slug:t})})).json();
      if(r.ok){MODEL_ACTIVE=t;notify('Restored pre-web model','sys');renderModelSel();}}catch(e){}
  }
  // New conversation: rotate BOTH route sessions server-side; the agent forgets this chat.
  async function newConversation(){
    try{const r=await(await fetch('/session/reset',{method:'POST'})).json();
      notify(r&&r.message?r.message:'New conversation started.', r&&r.ok?'sys':'err');}
    catch(e){notify('New conversation failed: '+e,'err');}
  }

  // Web research access: reflect + toggle the per-agent runtime state (state/web-access.json).
  // OFF (default) is a structural boundary -- the turn denies WebSearch/WebFetch, so the agent
  // cannot reach the web.
  function renderWeb(){const b=document.getElementById('webToggle');if(!b)return;b.textContent='web: '+(WEB_ON?'ON':'OFF');b.style.color=WEB_ON?'var(--accent)':'#aaa';b.title='Web research is '+(WEB_ON?'ON - the agent can search/fetch the web':'OFF - structural boundary: the agent cannot reach the web')+'. Click to toggle.';}
  async function toggleWeb(){const next=!WEB_ON;webBusy=Date.now();try{const r=await(await fetch('/web-access',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({enabled:next})})).json();if(r&&r.ok){WEB_ON=!!r.enabled;renderWeb();renderModelSel();notify(r.message||('Web research '+(WEB_ON?'ENABLED':'DISABLED')),'sys');if(WEB_ON)ensureWebModel();else restorePrevModel();}else{notify('Web toggle failed: '+((r&&r.error)||'unknown'),'err');}}catch(e){notify('Web toggle failed: '+e,'err');}finally{webBusy=Date.now();}}
  // Reflect toggles made elsewhere (e.g. the Aegis panel) without a reload: poll the shared
  // state, update only on change, don't clobber a state just set here (webBusy window).
  async function syncWeb(){if(Date.now()-webBusy<4000)return;try{const r=await(await fetch('/web-access')).json();if(r&&r.ok&&!!r.enabled!==WEB_ON){WEB_ON=!!r.enabled;renderWeb();renderModelSel();if(WEB_ON)ensureWebModel();else restorePrevModel();}}catch(e){}}

  function init(opts){
    if(opts&&typeof opts.notify==='function')notify=opts.notify;
    fetch('/model').then(r=>r.json()).then(d=>{
      if(d&&d.ok){MODELS=d.options||[];MODEL_ACTIVE=d.active||null;WEB_ON=!!d.webActive;}
      renderWeb();renderModelSel();
    }).catch(()=>{renderWeb();const bar=document.getElementById('modelbar');if(bar)bar.textContent='model: (unavailable)';});
    ensureProtBadge();renderProt();syncProt();ensurePersonaBtn();ensureImportBtn();
    setInterval(syncWeb,8000);
    setInterval(syncProt,8000);
  }

  // Fleet protection badge: MIRROR of the workstation policy (pushed by Aegis)
  // plus a request lane. Clicking never mutates policy -- it records a request
  // the operator completes as the attested ceremony in Aegis.
  var PROT={protected:false,requested:null};
  function renderProt(){var b=document.getElementById('protBadge');if(!b)return;var t=PROT.protected?'\u{1F6E1}':'\u25CB';if(PROT.requested)t+='\u00B7';b.textContent=t;b.style.color=PROT.protected?'#22c55e':'#777';b.title=(PROT.protected?'Decommission is policy-refused for this agent.':'No decommission guard on this agent.')+' Click to request a change; the attested ceremony completes in Aegis.';}
  function ensureProtBadge(){if(document.getElementById('protBadge'))return;var wb=document.getElementById('webToggle');if(!wb||!wb.parentNode)return;var b=document.createElement('button');b.id='protBadge';b.style.cssText='margin-right:8px;background:none;border:1px solid #333;border-radius:6px;padding:4px 8px;cursor:pointer;font:inherit;color:#aaa';b.onclick=toggleProt;wb.parentNode.insertBefore(b,wb);}
  async function syncProt(){try{var r=await(await fetch('/protection')).json();if(r&&r.ok){PROT={protected:!!r.protected,requested:r.requested||null};renderProt();}}catch(e){}}
  async function toggleProt(){var want=PROT.protected?'unprotect':'protect';try{var r=await(await fetch('/protection',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({request:want})})).json();if(r&&r.ok){PROT={protected:!!r.protected,requested:r.requested||null};renderProt();notify(r.message||('Protection '+want+' requested \u2014 complete the attested ceremony in Aegis.'),'sys');}else{notify('Protection request failed: '+((r&&r.error)||'unknown'),'err');}}catch(e){notify('Protection request failed: '+e,'err');}}

  // Persona editor: view/edit the agent's conversational identity in place.
  // Values live per agent (state/persona.txt override wins over the baked default).
  async function editPersona(){
    try{
      var r=await(await fetch('/persona')).json();
      var cur=(r&&(r.persona||r.text))||'';
      var ov=document.createElement('div');
      ov.style.cssText='position:fixed;inset:0;background:rgba(0,0,0,.65);z-index:99;display:flex;align-items:center;justify-content:center';
      var box=document.createElement('div');
      box.style.cssText='background:#111;border:1px solid #333;border-radius:8px;padding:14px;width:min(680px,92vw)';
      box.innerHTML='<div style="margin-bottom:6px;color:#ddd">Persona'+(r&&r.custom?' <span style="color:#f59e0b">(custom override active)</span>':'')+'</div>'
        +'<textarea id="personaTa" style="width:100%;height:220px;background:#0a0a0a;color:#eee;border:1px solid #2a2a2a;border-radius:6px;padding:8px;font:12px/1.5 ui-monospace,monospace"></textarea>'
        +'<div style="margin-top:8px;display:flex;gap:8px;justify-content:flex-end"><button id="personaCancel">Cancel</button><button id="personaSave">Save</button></div>';
      ov.appendChild(box);document.body.appendChild(ov);
      document.getElementById('personaTa').value=cur;
      document.getElementById('personaCancel').onclick=function(){ov.remove();};
      document.getElementById('personaSave').onclick=async function(){
        try{var rr=await(await fetch('/persona',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({persona:document.getElementById('personaTa').value})})).json();
          notify(rr&&rr.ok?'Persona saved (override active; applies to the next message).':'Persona save failed: '+((rr&&rr.error)||'unknown'),rr&&rr.ok?'sys':'err');
        }catch(e){notify('Persona save failed: '+e,'err');}
        ov.remove();
      };
    }catch(e){notify('Persona load failed: '+e,'err');}
  }
  function ensurePersonaBtn(){if(document.getElementById('personaBtn'))return;var wb=document.getElementById('webToggle');if(!wb||!wb.parentNode)return;var b=document.createElement('button');b.id='personaBtn';b.textContent='persona';b.title='View/edit this agent\u2019s persona (override wins over the repo default)';b.style.cssText='margin-right:8px;background:none;border:1px solid #333;border-radius:6px;padding:4px 8px;cursor:pointer;font:inherit;color:#aaa';b.onclick=editPersona;wb.parentNode.insertBefore(b,wb);}

  // Import lane UI: mirrors the Aegis card import against the fleet-core
  // /files endpoints every agent already serves (stage -> staged -> Process
  // hands the file to this agent's pipeline dir). Mechanism in core; the
  // destination is the agent's own stage_dest.
  async function importOverlay(){
    var ov=document.createElement('div');
    ov.style.cssText='position:fixed;inset:0;background:rgba(0,0,0,.65);z-index:99;display:flex;align-items:center;justify-content:center';
    var box=document.createElement('div');
    box.style.cssText='background:#111;border:1px solid #333;border-radius:8px;padding:14px;width:min(560px,92vw);color:#ddd;font:13px/1.5 ui-monospace,monospace';
    box.innerHTML='<div style="margin-bottom:8px">Import \u2014 stage a file; Process hands it to this agent\u2019s pipeline dir.</div>'
      +'<div style="display:flex;gap:8px;align-items:center"><input type="file" id="impFile" style="flex:1 1 0%;min-width:0;color:#bbb"><button id="impStageBtn">Stage</button></div>'
      +'<div id="impListBox" style="margin-top:10px;color:#aaa">loading staged\u2026</div>'
      +'<div style="margin-top:10px;display:flex;justify-content:flex-end"><button id="impClose">Close</button></div>';
    ov.appendChild(box);document.body.appendChild(ov);
    document.getElementById('impClose').onclick=function(){ov.remove();};
    async function list(){
      var el=document.getElementById('impListBox'); if(!el)return;
      try{var r=await(await fetch('/files/staged')).json();
        if(!r||!r.ok){el.textContent='staged list unavailable';return;}
        el.innerHTML=((r.files||[]).map(function(x){return x.name+' ('+x.bytes+'b) <button data-n="'+x.name.replace(/"/g,'')+'" class="impProc">Process \u2192 '+r.dest+'</button>';}).join('<br>'))||'(nothing staged)';
        Array.prototype.forEach.call(el.querySelectorAll('.impProc'),function(btn){btn.onclick=async function(){
          try{var rr=await(await fetch('/files/process',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({name:btn.getAttribute('data-n')})})).json();
            notify(rr&&rr.ok?rr.message:('process failed: '+((rr&&rr.error)||'unknown')),rr&&rr.ok?'sys':'err');
          }catch(e){notify('process failed: '+e,'err');}
          list();
        };});
      }catch(e){el.textContent='staged list unavailable: '+e;}
    }
    document.getElementById('impStageBtn').onclick=function(){
      var f=(document.getElementById('impFile').files||[])[0];
      if(!f){notify('choose a file first','err');return;}
      var rd=new FileReader();
      rd.onload=async function(){
        var b64=String(rd.result).split(',')[1]||'';
        try{var r=await(await fetch('/files/stage',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({name:f.name,dataBase64:b64})})).json();
          notify(r&&r.ok?r.message:('stage failed: '+((r&&r.error)||'unknown')),r&&r.ok?'sys':'err');
        }catch(e){notify('stage failed: '+e,'err');}
        list();
      };
      rd.readAsDataURL(f);
    };
    list();
  }
  function ensureImportBtn(){if(document.getElementById('importBtn'))return;var wb=document.getElementById('webToggle');if(!wb||!wb.parentNode)return;var b=document.createElement('button');b.id='importBtn';b.textContent='import';b.title='Stage a file to this agent; Process hands it to the pipeline dir';b.style.cssText='margin-right:8px;background:none;border:1px solid #333;border-radius:6px;padding:4px 8px;cursor:pointer;font:inherit;color:#aaa';b.onclick=importOverlay;wb.parentNode.insertBefore(b,wb);}

  window.toggleWeb = toggleWeb;
  window.newConversation = newConversation;
  window.ChatControls = { init: init };
})();

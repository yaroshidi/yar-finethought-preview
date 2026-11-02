"use strict";



const ALIAS = {};   // /ar retired for now; it 301s to / server-side

/* Where a question goes when nothing is written about it yet.
   This used to be /404, which meant the tab, the history entry and any bookmark
   all read "Page not found" for a state that is not an error, and the question
   itself was nowhere in the URL, so the answer could not be shared or reloaded.
   /ask is a real page with its own title, and the ask form posts to it with
   JavaScript off, so the entry point survives without this file. */
const ASK_PATH = "/ask";
const askUrl = q => ASK_PATH + (q && q.trim() ? "?q=" + encodeURIComponent(q.trim()) : "");
const PRESETS = [["What do you offer?","/services"],["What do you cost?","/pricing"],["How does the setup work?","/process"],["Show me your work","/projects"],["Who am I?","/about"],["Are you available?","/contact"]];

/* ============================================================
   ANSWERS — fetched from the real pages.
   Every answer is a real HTML document (public/<route>.html) whose #answer
   section holds the copy. This script never stores a second copy of it, so
   editing the page is the only way to change what the site says.
   ============================================================ */
const ROUTES = new Set();   // filled from the index at boot
const PAGES = new Map();

async function loadPage(path){
  if(PAGES.has(path)) return PAGES.get(path);
  try{
    const res = await fetch(path, {headers:{"Accept":"text/html"}});
    if(!res.ok) return null;
    const doc = new DOMParser().parseFromString(await res.text(), "text/html");
    const el = doc.querySelector("#answer");
    if(!el) return null;
    // The title comes from the page too, so a soft navigation leaves the tab and
    // the history entry saying what a hard load of the same URL would say.
    const page = { q: el.dataset.q || "", html: el.innerHTML,
                   title: (doc.querySelector("title")||{}).textContent || "" };
    PAGES.set(path, page);
    return page;
  }catch(e){ return null; }
}



/* ============================================================
   ROUTER — real URLs, soft navigation, deep links, back/forward
   ============================================================ */
const $ = s=>document.querySelector(s);
const body=document.body, stage=$("#stage"), input=$("#input"), field=$("#field"),
      answerEl=$("#answer");
// Captured before any navigation can overwrite it, so returning home restores
// the title the server would send for "/" rather than keeping the last answer's.
const HOME_TITLE = document.title;

/* ============================================================
   MATCHING — scored, word-boundary, and allowed to say no.

   The old matcher tested substrings, so a pattern containing "you" swallowed
   almost every question and answered it with /about. This one scores against
   an index built from what the pages actually say (public/site/answers.json)
   and returns nothing when it is not confident, because the site promises it
   will not guess.
   ============================================================ */
let INDEX = [];

const STOP = new Set(("a an the and or but if then so of to in on for with at by from as is are am be " +
  "been was were it its this that these those i me my we our you your yours they them their he she " +
  "his her do does did done have has had can could should would will shall may might must what when " +
  "where which who whom why how much many more most other some such no nor not only own same too very " +
  "just also than there here about into over under again further once all any both each few out up down off " +
  "take takes taking get gets got give gives make makes made want need needs like know think see tell say let " +
  // norm() turns an apostrophe into a space, so "what's" arrives as "what" plus
  // a stray "s", while "whats" arrives whole. Both are stopwords carrying no
  // topic, and without them here they scored as if they were real terms.
  "whats hows wheres whos whens whys thats theres heres lets im ive id ill youre youve youll " +
  "dont doesnt didnt cant cannot wont wouldnt shouldnt couldnt isnt arent wasnt werent havent hasnt hadnt").split(" "));

/* Platforms and disciplines this site does not claim. A question naming one is
   not a near miss on some page, so it never resolves locally: it goes to the AI,
   which declines or routes it honestly. Without this, "do you build shopify
   sites" collects enough incidental prose overlap to land on a real page. */
const OFF_TOPIC = new Set(("shopify wordpress wp squarespace wix framer webstudio drupal magento joomla " +
  "ghost bubble softr glide retool salesforce hubspot sharepoint " +
  "swift kotlin android ios flutter unity unreal photoshop illustrator indesign").split(" "));

/* Visitors ask about Yar in the third person. The index is written in the
   second, because that is how the pages speak. "What does Yar actually do?" and
   "what do you do" are the same question, and the curated aliases only ever
   matched the second, so the first fell through to the paid tier and then to
   "I haven't written that one up yet" about a page that exists.

   Three normalisations close that gap, applied to questions and to the index
   alike so both sides meet in the middle:
     yar, yaroshidi, he, his, him   ->  you / your
     does, did                      ->  do        (so "what does" meets "what do")
     actually, really, exactly …    ->  dropped   (filler between alias words)
   None of them change what a question means, and all three are reversible in
   the sense that nothing else in the file depends on the raw string. */
const SELF = {yar:"you", yaroshidi:"you", roshidi:"you", he:"you", him:"you", his:"your", himself:"yourself"};
const VERB = {does:"do", did:"do", "doin":"do", doing:"do"};
const FILLER = new Set("actually really exactly specifically basically simply literally honestly precisely".split(" "));

function norm(s){
  const flat = String(s).toLowerCase().replace(/[^a-z0-9\s]/g," ").replace(/\s+/g," ").trim();
  if(!flat) return flat;
  const out = [];
  for(const w of flat.split(" ")){
    if(FILLER.has(w)) continue;
    out.push(SELF[w] || VERB[w] || w);
  }
  return out.join(" ");
}
/* Single characters are apostrophe debris, never terms. */
function toks(s){ return norm(s).split(" ").filter(t=>t.length>1 && !STOP.has(t)); }

async function loadIndex(){
  if(INDEX.length) return INDEX;
  try{
    const r = await fetch("/site/answers.json");
    if(r.ok) INDEX = await r.json();
  }catch(e){}
  // Both sides have to be normalised or they stop meeting. A question becomes
  // "who is you" and a stored alias stays "who is yar", and an alias that used
  // to match silently never fires again. Normalising here means the file on
  // disk stays readable in whichever person it was written.
  for(const e of INDEX){
    e.syn = [...new Set((e.syn||[]).map(norm).filter(Boolean))];
    e.terms = [...new Set((e.terms||[]).map(norm).filter(Boolean))];
  }
  return INDEX;
}

/* How many entries share a term. A word only one page uses ("aeo", "figma")
   identifies that page; a word everyone uses ("webflow") identifies nothing. */
let DF=null;
function buildDF(){
  DF=new Map();
  for(const e of INDEX) for(const t of new Set(e.terms)) DF.set(t,(DF.get(t)||0)+1);
}
function weight(term){
  const df=(DF&&DF.get(term))||1;
  return df<=1 ? 6 : df===2 ? 4 : 2;
}

function score(entry,q){
  const nq=norm(q);
  const nq_e=norm(entry.q);
  if(nq_e===nq) return 1000;                   // exact question, stopwords and all
  if(nq && nq_e.indexOf(nq)===0) return 40;    // "what is aeo" opening "what is aeo and how is it..."
  // Curated multi-word aliases are tested against the raw question, before
  // stopwords are dropped. "who are you" and "what do you do" are nothing but
  // stopwords, and they are two of the likeliest things anyone types here.
  let s=0;
  const hit=new Set();
  for(const term of (entry.syn||[])){
    if(term.indexOf(" ")>-1 && nq.indexOf(term)>-1){ s+=8; term.split(" ").forEach(w=>hit.add(w)); }
  }

  const qt=toks(q);
  if(!qt.length) return s;   // all-stopword question: the alias is the only signal there is
  const qset=new Set(qt);
  for(const term of (entry.syn||[])){                            // single-word intent aliases
    if(term.indexOf(" ")===-1 && qset.has(term)){ s+=7; hit.add(term); }
  }
  for(const term of entry.terms){
    if(term.indexOf(" ")>-1){ if(nq.indexOf(term)>-1){ s+=6; term.split(" ").forEach(w=>hit.add(w)); } }
    else if(qset.has(term)){ s+=weight(term); hit.add(term); }
  }
  for(const t of toks(entry.q)) if(qset.has(t)){ s+=2; hit.add(t); }

  // How much of what they actually asked did we match? One incidental word out
  // of five is a coincidence, not an answer.
  const coverage = hit.size / qt.length;
  if(coverage < 0.34) s = Math.floor(s * 0.4);
  return s;
}

function rank(q){
  return INDEX.map(e=>({e,s:score(e,q)})).filter(x=>x.s>0).sort((a,b)=>b.s-a.s);
}

/* A curated alias on its own clears this; a single word lifted from page prose
   does not, because prose contains words about clients, not about the topic. */
const CONFIDENT = 7;

function resolve(q){
  const r=rank(q);
  if(!r.length) return null;
  const top=r[0], second=r[1];
  if(top.s>=40) return top.e.path;                 // the question itself, or its opening
  if(toks(q).some(t=>OFF_TOPIC.has(t))) return null;
  if(top.s<CONFIDENT) return null;
  // Two pages scoring identically is ambiguity, not confidence. Ordering would
  // pick the winner, and ordering is just where the entry sits in the file.
  if(second && second.s===top.s) return null;
  return top.e.path;
}

/* The bar a typed question has to clear to skip the AI and open a page
   directly. resolve() alone is too loose for that: it sent "what does the
   retainer not cover" to the pricing page, which mentions a retainer and says
   nothing about what it excludes. Here every topic word in the question has to
   be something the page itself is indexed under, so a question that asks for
   more than the page covers still goes to the AI. */
function covered(entry,q){
  const own=new Set(entry.terms);
  for(const a of (entry.syn||[])) for(const w of a.split(" ")) own.add(w);
  for(const w of toks(entry.q)) own.add(w);
  return toks(q).every(t=>own.has(t));
}
function resolveTyped(q){
  const r=rank(q);
  if(!r.length) return null;
  if(r[0].s>=40) return r[0].e.path;
  const path=resolve(q);
  if(!path) return null;
  const e=INDEX.find(x=>x.path===path);
  return e && covered(e,q) ? path : null;
}

/* Closest real questions, for when there is no confident answer. */
const RELEVANT = 4;   // below this a "suggestion" is just a shared common word
function suggest(q,n=3){
  const r=rank(q).filter(x=>x.s>=RELEVANT).slice(0,n).map(x=>x.e);
  if(r.length) return r;
  const fallback=["/services","/projects","/contact"];
  return fallback.map(p=>INDEX.find(e=>e.path===p)).filter(Boolean);
}

/* Four framings of this page, one at a time: url (here is everything),
   thinking (the AI is composing), answered (it came back), unanswered (it came
   back with nothing). data-when takes a space separated list so an element can
   survive more than one. thinking and unanswered were one state until the miss
   copy was caught claiming "I haven't written that one up yet" while the answer
   was still being written. */
function setAskState(state){
  answerEl.querySelectorAll("[data-when]").forEach(el=>{
    el.hidden = !el.getAttribute("data-when").split(/\s+/).includes(state);
  });
}

/* Swap the 404 page's static follow-ups for the closest actual matches. */
function applySuggestions(q){
  // The page ships both framings: a bad URL and an unanswered question are not
  // the same thing. Show whichever applies; the copy itself stays in the HTML.
  const asked = !!(q && q.trim());
  setAskState(asked ? "thinking" : "url");
  if(asked){
    const h=answerEl.querySelector("#answer-title");
    if(h) h.textContent=q;                       // echo what they actually asked
  }
  if(asked) askAI(q.trim());
  const wrap=answerEl.querySelector(".follows");
  if(!wrap || !asked) return;
  const picks=suggest(q);
  if(!picks.length) return;
  const labels=[...wrap.querySelectorAll(".l")];
  wrap.innerHTML="";
  labels.forEach(l=>wrap.appendChild(l));
  for(const e of picks){
    const b=document.createElement("button");
    b.type="button"; b.className="chip"; b.dataset.ask=e.q; b.textContent=e.q;
    wrap.appendChild(b);
  }
}

/* ============================================================
   TIER 1+2 — capped on-site AI, then handoff to bigger AIs.
   One question, one answer. Follow-ups happen in ChatGPT and
   friends with this site pre-loaded as the source: that is the
   point, not a fallback apology.
   ============================================================ */
const AI_ENDPOINT = "/api/ask";
const LOG_ENDPOINT = "/api/field-event";
let aiSeq = 0;   // navigation guard: only the newest ask may paint

function externalLinks(q){
  const enc = encodeURIComponent("Using the content of https://yar.website, answer: " + q);
  return [
    ["ChatGPT",        "https://chatgpt.com/?q=" + enc],
    ["Perplexity",     "https://www.perplexity.ai/search?q=" + enc],
    ["Google AI Mode", "https://www.google.com/search?udm=50&q=" + enc]
  ];
}

/* "Take me home" is a request to navigate, not a question. It never deserves
   an AI call, and the smart answer is the act itself: go home. */
const NAV_HOME = /^(?:(?:take|bring) me |go |back )?(?:home|homepage|main page|start(?: over)?)$/;

function renderHandoff(box, q, lead){
  const p = document.createElement("p");
  p.className = "ai-lead"; p.textContent = lead;
  const row = document.createElement("div");
  row.className = "llm-links";
  for(const [name, url] of externalLinks(q)){
    const a = document.createElement("a");
    a.className = "chip"; a.href = url; a.target = "_blank"; a.rel = "noopener";
    a.textContent = "Ask " + name;
    row.appendChild(a);
  }
  box.append(p, row);
}

/* How the question currently being handled was started. Set at each entry
   point and read by the logger and by askAI. It lives here rather than being
   passed down because the chain from a click to askAI runs through typeThenGo,
   go and applySuggestions, and threading one string through all of them would
   change every signature on the path. */
let askSource = "typed";

function logEvent(q, kind, slug){
  try{
    navigator.sendBeacon(LOG_ENDPOINT,
      new Blob([JSON.stringify({q: q, kind: kind, slug: slug || null, source: askSource, ref: document.referrer || null})],
        {type: "application/json"}));
  }catch(e){}
}

async function askAI(q){
  // Every early return here has to land the page somewhere honest. Leaving it
  // in "thinking" would spin forever on a question that was never sent.
  if(NAV_HOME.test(norm(q))){ setAskState("unanswered"); return; }
  const seq = ++aiSeq;
  // The AI answer leads the page: it renders directly under "I haven't written
  // that one up yet", above the site-wide list, not buried in the footer of
  // the answer. The .follows anchor is the fallback if the ask page's lead
  // block ever changes shape.
  const lead = answerEl.querySelector(".lead");
  const leadBlock = lead && lead.closest(".b");
  const anchor = (leadBlock && leadBlock.nextElementSibling) || answerEl.querySelector(".follows");
  if(!anchor){ setAskState("unanswered"); return; }
  const box = document.createElement("div");
  box.className = "ai-block";
  box.setAttribute("role","status");
  // The lead already says "I'm thinking about this one", so this is the arc
  // alone, turning where the answer is about to land. The label is for screen
  // readers, which get nothing from a spinning border.
  const think = document.createElement("p");
  think.className = "ai-lead thinking";
  const spin = document.createElement("span");
  spin.className = "spin"; spin.setAttribute("aria-hidden","true");
  const said = document.createElement("span");
  said.className = "sr-only"; said.textContent = "Working on your answer";
  think.append(spin, said);
  box.appendChild(think);
  anchor.parentNode.insertBefore(box, anchor);

  /* The endpoint streams: line one is JSON metadata, everything after the first
     newline is the answer, arriving as it is written. Metadata comes first so a
     redirect verdict lands before any prose is painted, because on a redirect
     the page navigates and prose would be thrown away.

     over_limit and error still answer as a single JSON object, so both shapes
     are handled: a response that parses whole is the old kind, otherwise the
     first line is metadata and the rest is streamed in. */
  let out = null, painted = null;
  try{
    const res = await fetch(AI_ENDPOINT, {
      method: "POST",
      headers: {"content-type": "application/json"},
      body: JSON.stringify({q: q, hp: (document.getElementById("hp") || {}).value || "", source: askSource, ref: document.referrer || null})
    });
    if(res.ok && res.body && (res.headers.get("content-type")||"").indexOf("text/plain") === 0){
      const reader = res.body.getReader(), dec = new TextDecoder();
      let head = "", meta = null;
      for(;;){
        const {done, value} = await reader.read();
        if(done) break;
        if(seq !== aiSeq || !box.isConnected){ reader.cancel(); return; }
        const chunk = dec.decode(value, {stream:true});
        if(!meta){
          head += chunk;
          const nl = head.indexOf("\n");
          if(nl === -1) continue;
          try{ meta = JSON.parse(head.slice(0, nl)); }catch(e){ meta = {kind:"ai_ok"}; }
          out = meta;
          if(meta.redirect && meta.related && ROUTES.has(meta.related)){
            reader.cancel(); box.remove(); go(meta.related, q); return;
          }
          // First real text: the spinner's job is done, the answer takes over.
          setAskState("answered");
          box.textContent = "";
          painted = document.createElement("p");
          painted.className = "ai-answer";
          box.appendChild(painted);
          const rest = head.slice(nl + 1);
          if(rest) painted.textContent = rest;
          continue;
        }
        painted.textContent += chunk;
      }
      if(out && painted) out.answer = painted.textContent.trim();
    }else if(res.ok){
      out = await res.json();
    }
  }catch(e){}
  if(seq !== aiSeq || !box.isConnected) return;   // visitor moved on

  // A streamed answer is already on the page; only the trimmings are left.
  if(painted){
    // A trailing code fence cannot be stripped mid-stream, because until the
    // stream ends it might be the start of real text. Clean it once at the end.
    painted.textContent = painted.textContent.replace(/\s*```\s*$/, "").trim();
    if(out.related && ROUTES.has(out.related)){
      const a = document.createElement("a");
      a.className = "chip"; a.href = out.related; a.dataset.ask = q;
      a.textContent = "Read more on this site";
      box.appendChild(a);
    }
    renderHandoff(box, q, out.kind === "ai_declined"
      ? "That one is outside what I do. For everything else:"
      : "Take it further in a bigger AI, with this site as the source:");
    return;
  }

  box.textContent = "";
  const kind = (out && out.kind) || "error";
  if(kind === "ai_ok"){
    // The AI can rule that this question is an existing page's question in
    // different words. The page is the answer, so go there, the same move a
    // local hit makes. The one-line caption is logged server-side for mining
    // new free aliases, not shown: navigation explains itself.
    if(out.redirect && out.related && ROUTES.has(out.related)){
      box.remove();
      go(out.related, q);
      return;
    }
    // The answer leads now, so the page stops calling itself a miss.
    setAskState("answered");
    const p = document.createElement("p");
    p.className = "ai-answer"; p.textContent = out.answer;
    box.appendChild(p);
    if(out.related && ROUTES.has(out.related)){
      const a = document.createElement("a");
      a.className = "chip"; a.href = out.related; a.dataset.ask = q;
      a.textContent = "Read more on this site";
      box.appendChild(a);
    }
    renderHandoff(box, q, "Take it further in a bigger AI, with this site as the source:");
  }else if(kind === "over_limit"){
    // The cap means the AI never looked. Saying "I haven't written that one up
    // yet" here states a verdict on coverage that was never reached, which is
    // the same mistake the thinking state used to make one step earlier.
    setAskState("capped");
    renderHandoff(box, q, "The on-site AI has answered enough for now. These will answer, citing this site:");
  }else if(kind === "ai_declined"){
    // The model writes a specific one line decline. Show that, not a canned
    // stand-in that throws away the only part it was asked to get right.
    setAskState("unanswered");
    renderHandoff(box, q, out.answer || "That one is outside what I do. For everything else:");
  }else{
    setAskState("unanswered");
    renderHandoff(box, q, "Ask one of these instead, with this site as the source:");
  }
}

/* How many steps this visitor has taken inside the site. It rides in the history
   state so it survives back and forward. "Back" is site chrome and reads as
   "back within this site", but it was history.back() with no check, so anyone
   arriving from a search result, which for this site is the main way in, was
   sent straight out again. At depth 0 there is nowhere in-site to go, so the
   button is not offered. */
let depth = (history.state && history.state.depth) || 0;
function syncBack(){
  const b=document.getElementById("back");
  if(b) b.hidden = depth <= 0;
}

function setUrl(path,push,title){
  // a section owns its children: an article under /resources marks Resources
  const bare=path.split("?")[0];
  document.querySelectorAll("#nav a").forEach(a=>{
    const r=a.dataset.route;
    const on = r===bare || (r!=="/" && bare.startsWith(r+"/"));
    a.setAttribute("aria-current", on ? "page" : "false");
  });
  if(title) document.title = title;
  if(!push){ syncBack(); trackPageView(path,title); return; }
  // Real paths, not "#/contact". Every route here is a real HTML file that the
  // server answers on its own, so the pushed URL is one you can copy, share and
  // reload. The hash was a holdover from when these pages did not exist yet.
  depth++;
  try{ history.pushState({path,depth},"",path); }
  catch(e){ try{ history.pushState({path,depth},""); }catch(e2){} }
  syncBack();
  trackPageView(path,title);
}

// Navigation here is simulated with pushState, so gtag's automatic pageview
// (fired once per real document load) misses every in-page route change. The
// first call is skipped so the load itself is not counted twice.
let gaFirstView = true;
function trackPageView(path,title){
  if(gaFirstView){ gaFirstView = false; return; }
  if(typeof gtag!=="function") return;
  gtag("event","page_view",{
    page_path:path,
    page_location:location.origin+path,
    page_title:title||document.title
  });
}


function paint(page){
  answerEl.innerHTML = page ? page.html : "";
  answerEl.classList.remove("reveal");
  answerEl.querySelectorAll(".b,.hr").forEach((el,i)=>el.style.transitionDelay=(i*42)+"ms");
  void answerEl.offsetWidth;
  requestAnimationFrame(()=>{
    answerEl.classList.add("reveal");
    const h=answerEl.querySelector("#answer-title");
    if(h) h.focus({preventScroll:true});
  });
}

/* The ask box is one element, the Composer card (.pinner), and every move it
   makes is GSAP Flip on that card: record where it is, change the classes,
   play the difference, size included (scale:false, so its words never
   stretch). The old FLIP translated the form inside the card, so under an
   answer the card's empty frame landed first and the input row slid down into
   it (measured 2026-10-13). On a phone the theme key rests in the top band on
   the homepage and beside the docked field on an answer, so it rides the same
   movement; prune leaves it alone where it does not move. Without GSAP, or
   with reduced motion, the classes change and everything lands in place. */
const askSlot = document.getElementById("promptblock");
const askCard = askSlot && askSlot.querySelector(".pinner");
const ASK_EASE = "power4.out";   // the curve of --ease, cubic-bezier(.23,1,.32,1)
if(window.gsap && window.Flip) gsap.registerPlugin(Flip);
let askTween = null;
function morph(mutate, targets, opts){
  opts = opts || {};
  const done = opts.onComplete;
  targets = (targets || []).filter(Boolean);
  // a move still in flight lands first, so the next one starts from a real place
  if(askTween){ const t = askTween; askTween = null; t.progress(1); }
  if(!(window.gsap && window.Flip) || (REDUCED && REDUCED.matches) || !targets.length){
    mutate(); if(done) done(); return;
  }
  const state = Flip.getState(targets);
  mutate();
  askTween = Flip.from(state, Object.assign({duration:.46, ease:ASK_EASE, scale:false, prune:true}, opts, {
    onComplete(){ askTween = null; if(done) done(); }
  }));
}
function flip(mutate){ morph(mutate, [askCard, document.querySelector(".themedock")]); }
/* Clears everything the placement code wrote onto the card, so an answer or
   the homepage starts from the stylesheet's own rules. Called inside a morph,
   so the card still moves from where it was. */
function releaseCard(){
  if(!askSlot) return;
  askSlot.classList.remove("askfix","condensed","docked","open");
  askSlot.style.height="";
  askCard.style.cssText="";
}
/* Set by the homepage placement below: puts the card where the scroll says
   it belongs, from fresh measurements. Null on the answer pages. */
let askRestore = null;

async function go(path,query,push=true){
  const key = ALIAS[path]||path;
  // A miss falls back to the real /ask page rather than a copy held here.
  const missed = !ROUTES.has(key.split("?")[0]);
  const page = (await loadPage(key)) || (await loadPage(ASK_PATH));
  if(!typing) input.value = (page && page.q && !missed) ? page.q : (query || "");
  field.classList.toggle("on", !!input.value);
  // On a miss the question is the subject of the page, so it is what the tab,
  // the history entry and any bookmark should say.
  const asked = query && query.trim();
  setUrl(path,push, (missed && asked) ? asked + " | Yar" : (page && page.title));

  if(body.classList.contains("answered")){
    answerEl.classList.remove("reveal");
    // A glide back to the top is motion like any other: reduced motion jumps.
    setTimeout(()=>{ paint(page); if(missed) applySuggestions(query||"");
      stage.scrollTo({top:0,behavior:(REDUCED && REDUCED.matches) ? "instant" : "smooth"}); },140);
    input.blur(); return;
  }
  stage.scrollTop=0;
  body.classList.add("leaving");
  setTimeout(()=>{
    // From the hero, the open card or the pill alike: the slot gives up its
    // held height and the card docks under the answer.
    flip(()=>{ body.classList.remove("leaving"); body.classList.add("answered"); releaseCard(); });
    setTimeout(()=>{ paint(page); if(missed) applySuggestions(query||""); },130);
  },170);
  input.blur();
}

function home(push=true){
  if(!body.classList.contains("answered")){ setUrl("/",push,HOME_TITLE); return; }
  answerEl.classList.remove("reveal");
  setTimeout(()=>{
    // Put the hero in its pre-entrance state, FLIP the field, then release on
    // the next frame. The stagger lives in CSS transition-delays, so the hero
    // settles in behind the field on the same curve instead of popping.
    body.classList.add("returning");
    // Home starts at the hero. The stage kept the answer's scroll position, so
    // Escape from halfway down an answer landed in the client wall and the
    // card flew to a slot above the screen (2026-10-13).
    // The pill an answer page may have left on goes too, so the card lands
    // in the hero at rest.
    flip(()=>{ body.classList.remove("answered"); stage.scrollTop=0;
      releaseCard(); if(askRestore) askRestore(); });
    answerEl.innerHTML=""; input.value=""; field.classList.remove("on");
    setUrl("/",push,HOME_TITLE);
    // rAF gives the browser a frame to apply the pre-entrance state so the
    // transition actually runs. It does not fire in a background tab, so a
    // timer backs it up — otherwise the hero could be left invisible.
    const release=()=>body.classList.remove("returning");
    requestAnimationFrame(()=>requestAnimationFrame(release));
    clearTimeout(home._t);
    home._t=setTimeout(release,120);
  },140);
}

/* chip → type → navigate */
let typing=null;
/* True only while the typewriter itself focuses the field, so the ask box
   does not open for a question the page is about to answer. */
let askByMachine=false;
/* The pause between the last typed character and go(). It is a timer of its
   own, so it has to be cancellable like the interval: a second click inside
   that 90ms window used to let both navigations fire. */
let beatTimer=null;
/* How much of the current question the typewriter has written. If the visitor
   starts typing mid-question, their keystrokes land after this partial text, and
   the input handler strips it so they are left with only what they typed. */
let typedSoFar="";
/* Focusing the field is what shows the caret while the question writes. On a
   touch screen it also raises the on-screen keyboard, which then drops again
   when go() blurs the field, so a pill tap made the whole page jump twice. */
const FINE_POINTER = window.matchMedia ? window.matchMedia("(pointer: fine)") : null;

/* Ask, then answer — in that order. The question writes out at 16ms a
   character, one character at a time, and only once it is finished does the
   page move. Navigating in parallel put the answer on screen before the
   question was done, which reads as nonsense.
   The lag this used to have was never the cadence: it was a 210ms pause
   between the last character and any movement. That beat is now 60ms, which
   lands as punctuation rather than as waiting, and the target page is already
   prefetched on hover so navigation has nothing to fetch when it fires. */
const TYPE_TICK = 16;
const BEAT      = 60;

// The typewriter is CSS-free, so the reduced-motion preference could not reach
// it: the animation ran identically for someone who had asked for no motion.
const REDUCED = window.matchMedia ? window.matchMedia("(prefers-reduced-motion: reduce)") : null;

/* Cancelling the typewriter is its own function because three controls can
   interrupt it mid-word — Enter, Back, and the home mark — and each of them
   used to leave the interval running, so a second go() fired a beat after the
   one the user actually asked for. */
function stopTyping(){
  if(typing){ clearInterval(typing); typing = null; }
  clearTimeout(beatTimer); beatTimer = null;
  body.classList.remove("asking");
}

/* `dim` veils the page while the question writes, so the field is the only
   thing left at full strength. It is passed by the sidebar and withheld by the
   chips: the chips already sit next to the field and need no help pointing at
   it, while a nav click starts from the other side of the page. */
function typeThenGo(q,path,dim){
  path = path || resolve(q) || askUrl(q);
  stopTyping();
  field.classList.add("on");

  if(REDUCED && REDUCED.matches){ stopTyping(); input.value = q; go(path, q); return; }

  if(dim) body.classList.add("asking");
  if(!FINE_POINTER || FINE_POINTER.matches){ askByMachine=true; field.classList.add("auto"); input.focus({preventScroll:true}); askByMachine=false; }
  input.value=""; typedSoFar="";
  // The count comes from the clock, not from the number of ticks. Chrome runs
  // timers in a background tab once a second, and a busy main thread drops
  // ticks too; counting ticks turned a half-second question into twenty
  // seconds. A late tick now catches up to where the clock says it should be.
  let i = 0;
  const t0 = performance.now();
  typing = setInterval(()=>{
    i = Math.min(q.length, Math.max(i + 1, Math.floor((performance.now() - t0) / TYPE_TICK)));
    input.value = typedSoFar = q.slice(0, i);
    if(i >= q.length){
      clearInterval(typing); typing = null;
      // The veil lifts and the page moves on the same beat, so the release and
      // the transition read as one movement rather than two.
      beatTimer = setTimeout(()=>{ beatTimer = null; body.classList.remove("asking"); go(path, q); }, BEAT);
    }
  }, TYPE_TICK);
}

/* Home content (chips, FAQ, videos, posts) is real markup in body.html so it is
   present in the server-rendered HTML for crawlers. This script only attaches
   behaviour to it. */

/* Warm the answer before the click. Pointer-over on a chip or nav link
   fetches its page, so by the time it is clicked the markup is already
   cached and go() has nothing to wait for. */
(function(){
  const warm=new Set();
  const pull=e=>{
    const el=e.target.closest("[data-ask],#nav a");
    if(!el) return;
    const path = el.dataset.route ? (ALIAS[el.dataset.route]||el.dataset.route)
               : (el.getAttribute("href") || resolve(el.dataset.ask||""));
    if(!path || path==="/" || warm.has(path)) return;
    warm.add(path); loadPage(path);
  };
  document.addEventListener("pointerover", pull, {passive:true});
  document.addEventListener("touchstart", pull, {passive:true});
})();

/* Only index.html carries the hero content: the display heading, the chips and
   the sections below. home() un-hides those, which is right when this document
   IS the homepage and produces a blank page when it is not. On every other
   document, going home is a real navigation. */
const IS_HOME = !!document.getElementById("homescroll");
function goHome(){ if(IS_HOME) home(); else location.assign("/"); }

/* events */
// A modified click is a request for a new tab or window. Intercepting it made
// cmd-click, ctrl-click and middle-click silently navigate the current tab.
const plainClick = e => e.button===0 && !e.metaKey && !e.ctrlKey && !e.shiftKey && !e.altKey;

document.addEventListener("click",e=>{
  if(!plainClick(e)) return;
  const ask=e.target.closest("[data-ask]");
  if(ask){
    // The chips and follow-ups are real links. If the index never loaded we
    // cannot resolve the question, so let the href do the job rather than
    // routing a perfectly good link into the 404.
    if(!INDEX.length && ask.getAttribute("href")) return;
    e.preventDefault();
    // Clicking a chip is asking the question, and it was the one entry point
    // that recorded nothing. Every suggested question on the homepage and every
    // follow-up on every answer page was invisible in field_events.
    askSource = "chip";
    const cq = ask.dataset.ask, href = ask.getAttribute("href") || null;
    const dest = href || resolve(cq);
    if(dest) logEvent(cq, "local_hit", dest);
    typeThenGo(cq, href); return;
  }
  const nav=e.target.closest("#nav a");
  if(nav){
    const r=nav.dataset.route;
    if(r==="/"){ if(!IS_HOME) return; e.preventDefault(); home(); return; }
    e.preventDefault();
    const key=ALIAS[r]||r;
    // The sidebar asks its question the same way a chip does: the typewriter
    // runs first, and only when it finishes does the page move. This was cut
    // for the latency and put back deliberately — the gesture is the point.
    // Reduced motion still skips straight through, inside typeThenGo.
    loadPage(key).then(pg=>typeThenGo((pg&&pg.q)||nav.textContent.trim(), key, true));
  }
});
/* These four ran unguarded at the top level, so a page without one of them threw
   on load and took every listener below it with it: the router, the keyboard
   shortcuts, the mobile drawer, the theme and the booking popup all died at
   once. A page is allowed not to have an ask field. */
const bind = (el, ev, fn) => { if (el) el.addEventListener(ev, fn); };
/* A typed question opens its page directly when one plainly answers it, and
   goes to the AI otherwise. Sending every question to the AI made a question
   with its own page wait two to three seconds for the model to say "that's the
   pricing page". resolveTyped() is strict, so the AI still gets anything the
   page does not fully cover, and it can still redirect a paraphrase itself. */
bind(field,"submit",async e=>{ e.preventDefault(); stopTyping(); const q=input.value.trim(); if(!q) return;
  askSource = "typed";
  // goHome, as Escape does: typing "home" on any other page ran home(), which
  // left that page's empty hero at "/" (2026-10-13).
  if(NAV_HOME.test(norm(q))){ logEvent(q,"local_hit","/"); input.value=""; field.classList.remove("on"); goHome(); return; }
  if(!INDEX.length){ try{ await loadIndex(); buildDF(); }catch(err){} }
  const hit = INDEX.length ? resolveTyped(q) : null;
  if(hit){ logEvent(q,"local_hit",hit); go(hit,q); return; }
  go(askUrl(q),q); });
// A real keystroke fires this; setting input.value from the typewriter does not.
// So this is the user taking the field over, and the machine should let go of it
// rather than overwrite what they are typing from underneath.
bind(input,"input",()=>{
  if(typing || beatTimer){
    stopTyping();
    if(typedSoFar && input.value.indexOf(typedSoFar)===0) input.value = input.value.slice(typedSoFar.length);
  }
  typedSoFar="";
  field.classList.toggle("on",input.value.trim().length>0); });
/* The empty send key is a ghost that does nothing, so it says so to a screen
   reader too: aria-disabled follows field.on, which every path already sets. */
(function(){
  const send = field && field.querySelector(".go");
  if(!send) return;
  const sync=()=>send.setAttribute("aria-disabled", String(!field.classList.contains("on")));
  sync();
  new MutationObserver(sync).observe(field, {attributes:true, attributeFilter:["class"]});
})();
/* The topbar's Home button is gone (Yar, 2026-10-30): the sidebar carries
   Home on a desktop and the drawer carries it on a phone. Escape and the
   word "home" still go home, so goHome stays. */
bind($("#back"),"click",()=>{ stopTyping(); history.back(); });

window.addEventListener("popstate",e=>{
  // Every entry this router pushes carries {path}. A traversal with no state is
  // therefore not ours: it is a fragment navigation, and the skip link is one.
  // Reading its null state as "/" is what sent keyboard users to the homepage
  // from the one control that exists for them.
  if(!e.state || !e.state.path) return;
  stopTyping();
  depth = e.state.depth || 0; syncBack();
  const p=e.state.path;
  if(p==="/"){ if(!IS_HOME){ location.assign("/"); return; } home(false); } else go(p,null,false);
});

/* Docked, the field is already on screen: focusing it must not scroll the page
   back to the hero, which is what "/" did from anywhere below it. */
const askFocus = () => input.focus({preventScroll: !!(askSlot && askSlot.classList.contains("docked"))});
document.addEventListener("keydown",e=>{
  if((e.metaKey||e.ctrlKey)&&e.key.toLowerCase()==="k"){e.preventDefault();askFocus();input.select();}
  // goHome, not home: on a document that is not index.html there is no hero to
  // un-hide, so home() emptied the answer and left a blank page at "/". The
  // sr-only hint promises this key works, so it has to.
  else if(e.key==="Escape"){ if(body.classList.contains("nav-open")) return;
    // Escape belongs to the booking popup while it is open. Focus stays on the
    // booking link in the page, so the popup never sees the key; close it here
    // and stay on the page.
    const calBox=[...document.querySelectorAll("cal-modal-box")].find(m=>getComputedStyle(m).visibility!=="hidden");
    if(calBox){ e.preventDefault(); try{ (calBox.explicitClose||calBox.close).call(calBox); }catch(_){} return; } if(typing||beatTimer){ stopTyping(); input.value=""; field.classList.remove("on"); }
    // An open ask box closes first and the page stays where it is.
    if(askSlot && askSlot.classList.contains("open") && !body.classList.contains("answered")){ input.blur(); return; }
    input.blur();goHome();}
  // "/" typed into another field (the email gate on /tools) is a character
  else if(e.key==="/"&&document.activeElement!==input&&!(e.target.closest&&e.target.closest("input,textarea,select,[contenteditable]"))){e.preventDefault();askFocus();}
});

/* ============================================================
   THE ASK BOX FOLLOWS THE VISITOR (homepage, 2026-10-13)
   At rest the card sits in the hero. Clicked or focused it opens: from
   1100px wide its question grows to the lead size, and on windows from
   936px tall its input row grows by 14px into the gap above the figures,
   which stay where they are. Once half its slot has scrolled off the top,
   it docks as a pill at the foot of the screen, and opens there when
   clicked, focused, or called with / or Cmd-K. Scrolled back up, it returns
   to the hero. The slot holds the card's resting height while it is open
   or away, so the hero never reflows. Every move is one Flip of the one
   card (morph above).
   Windows 560px tall or less keep the card in the hero, the way answer
   pages put the docked field back in the flow there.
   ============================================================ */
(function(){
  if(!IS_HOME || !askSlot || !askCard || !stage) return;
  const is = c => askSlot.classList.contains(c);
  const busy = () => body.classList.contains("answered") || body.classList.contains("leaving") || body.classList.contains("returning");
  const PHONE = window.matchMedia ? matchMedia("(max-width:720px)") : null;
  const phone = () => !!(PHONE && PHONE.matches);

  /* THE FIELD IS A FUNCTION OF SCROLL (2026-10-19, third pass, Yar's spec).
     At load it is the centred pill at the foot of the first screen, the 14
     October home it had before (Yar: "the field should be in the center
     middle at the start, we had that before"). Scrolled, it condenses into
     the corner capsule beside the theme key, interpolating along a fixed
     band with the scroll itself as the easing — recomputed every frame from
     the scroll position, never from a stale measured rect, so it cannot
     drift or glitch on desktop or phone. A stopped scroll inside the band
     finishes its own glide. Open (click, focus, /) tweens the same inline
     box to the full dock; close returns it to wherever the scroll says.
     The hero slot keeps the card's resting height throughout, so the hero
     never reflows. */

  let restH=0;                             // the slot's resting height
  let pillLeft=0, pillW=360, pillH=46, pillBottom=42;  // the centred start pill
  let capW=118, capH=46, capLeft=0, capTop=0;          // the corner capsule
  let openLeft=0, openW=720, openH=0;                   // the open dock
  let ready=false, hold=false;
  const BAND=240, GAP=12;

  const clamp01=v=>v<0?0:v>1?1:v;
  const lerp=(a,b,t)=>a+(b-a)*t;
  const keyRect=()=>{ const k=document.querySelector(".themedock .themer"); return k?k.getBoundingClientRect():null; };

  function measure(){
    // numbers need nothing fixed: the slot is measured in the flow, the two
    // fixed states are computed from the viewport and the theme key
    const sr=stage.getBoundingClientRect();
    const r=askSlot.getBoundingClientRect();
    restH=r.height;
    // the capsule's width is its own content's, read from the card in its
    // condensed dress. Measured here in one synchronous block, so no paint
    // happens in between and nothing flashes; a hardcoded width would clip
    // the word or leave a slack edge as the type or the key changes.
    const slotClass=askSlot.className, cardStyle=askCard.getAttribute("style");
    askSlot.classList.add("askfix","docked","condensed");
    askCard.style.cssText="position:fixed;left:0;top:0;width:max-content;height:"+capH+"px;visibility:hidden";
    const natW=Math.ceil(askCard.offsetWidth);
    if(natW>60) capW=natW;
    askCard.setAttribute("style",cardStyle==null?"":cardStyle);
    askSlot.className=slotClass;
    const kr=keyRect();
    const bottom=phone()?16:42;
    if(kr && !phone()){
      // centred between the sidebar's edge and the key, on the key's line
      const cL=sr.left+ (innerWidth>720?52:28), cR=kr.left-GAP;
      pillW=360; pillLeft=cL+((cR-cL)-pillW)/2; pillBottom=42; pillH=46;
      capLeft=kr.left-GAP-capW; capTop=kr.bottom-capH;
    } else {
      // phone: the key rides the top band, the pill owns the foot's width
      pillW=innerWidth-32; pillLeft=16; pillBottom=16; pillH=46;
      capLeft=innerWidth-16-capW; capTop=innerHeight-16-capH;
    }
    const padX=innerWidth>720?52:28;
    const cL2=sr.left+padX, cR2=(kr&&!phone())?kr.left-GAP:sr.right-padX;
    openW=Math.max(280,Math.min(720,cR2-cL2));
    openLeft=cL2+((cR2-cL2)-openW)/2;
    ready=true;
  }

  // The card floats as the pill at every width; only windows 560px tall or
  // less keep it in the flow, as the SHORT rule above does. It is open, or an
  // answer is showing, in the same way at every width. The release still runs
  // here, so the card appears on load as it does docked.
  const inFlow=()=>innerHeight<=560 && !is("open") && !hold && !body.classList.contains("answered");

  // write the card at scroll progress p; the scroll is the easing
  function place(p){
    if(inFlow()){
      askSlot.classList.remove("askfix","docked","condensed");
      askSlot.style.height="";
      askCard.style.cssText="";
      if(!placed && !releaseRaf) releaseRaf=requestAnimationFrame(release);
      return;
    }
    const bottom=lerp(pillBottom, phone()?16:42, p);
    const L=lerp(pillLeft,capLeft,p), W=lerp(pillW,capW,p),
          H=lerp(pillH,capH,p), T=innerHeight-bottom-H;
    askSlot.classList.add("askfix","docked");
    askSlot.style.height=restH+"px";
    askCard.style.left=L+"px"; askCard.style.top=T+"px";
    askCard.style.width=W+"px"; askCard.style.height=H+"px";
    askCard.style.borderRadius="999px";
    const c=p>=.55;
    askSlot.classList.toggle("condensed",c);
  }

  function openDock(){
    if(busy()||is("open")) return;
    if(!ready) measure();
    hold=true;
    const bottom=phone()?16:42;
    const mutate=()=>{
      askSlot.classList.add("docked","open","askfix");
      askSlot.classList.remove("condensed");
      askSlot.style.height=restH+"px";
      askCard.style.left=openLeft+"px";
      askCard.style.width=openW+"px";
      askCard.style.height="auto";
      askCard.style.top="-2000px";
      askCard.style.borderRadius="22px";
      const pin=askCard; pin.style.borderRadius="22px";
      openH=askCard.offsetHeight;
      askCard.style.height=openH+"px";
      askCard.style.top=(innerHeight-bottom-openH)+"px";
      if(document.activeElement!==input) input.focus({preventScroll:true});
    };
    morph(mutate,[askCard],{duration:.42});
  }

  function closeDock(){
    if(!is("open")) return;
    hold=false;
    /* The same band the scroll uses, settled to the same nearer end. It read
       the hero slot's own top, which is hundreds of pixels down the page, so
       closing the dock while scrolled always worked out as p=0: the card came
       back as the foot pill with the page far down, and the next nudge of the
       wheel sent it to the corner (Yar, 2026-10-29). */
    const p=rawP()>=.5?1:0;
    shown=p; goal=p;
    const mutate=()=>{
      askSlot.classList.remove("open");
      place(p);
    };
    morph(mutate,[askCard],{duration:.42});
  }
  const y=()=>stage.scrollTop;

  /* THE GLIDE (2026-10-20, Yar: "the snap is too sudden and not smooth").
     The scroll no longer writes the card's position directly. It sets a
     goal, and one damped loop walks `shown` toward it a fraction of the
     remaining distance each frame, so a wheel's 100px jump arrives as
     motion rather than a teleport, and a stop mid-band finishes itself on
     the same curve as the motion that led there. There is no separate snap
     tween any more: leaving the band is just the loop still running. */
  let shown=0, goal=0, raf=0, idleT=null;
  /* The first 64px of scroll still count as the top, so a nudge of the wheel
     leaves the card where it is. It was 16px, which let the pill start drifting
     toward the corner on any scroll at all; 64 is the same distance the answer
     pages wait for before they dock (DOWN, below). */
  const START=64;
  const rawP=()=>clamp01((y()-START)/BAND);

  const loop=()=>{
    raf=0;
    if(busy()||hold) return;            // the dock or an answer owns the card
    const d=goal-shown;
    if(Math.abs(d)<0.0012){ shown=goal; place(shown); return; }
    shown+=d*0.2;
    place(shown);
    raf=requestAnimationFrame(loop);
  };
  /* Until the first placement lands, the card waits invisible. At load the
     hero's ask slot draws it in the flow for the frames before this script
     runs, and it was showing there, then dropping to the foot and rising
     again: three appearances in one second (Yar, 2026-10-20). The hold is
     released one frame after first paint, so the card appears at its foot
     position and nowhere else. The .arrive rise is the only motion it has
     at load; its keyframes start from opacity 0, so the release is a
     handover with nothing to see. Without JS, a <noscript> in the page lifts
     the hold, and the card stays in the flow. */
  let placed=false, releaseRaf=0;
  const release=()=>{ releaseRaf=0; if(placed) return; placed=true; askSlot.classList.add("asked"); };
  const placeOnce=p=>{
    place(p);
    if(!placed && !releaseRaf) releaseRaf=requestAnimationFrame(release);
  };
  const wake=()=>{ if(!raf) raf=requestAnimationFrame(loop); };

  stage.addEventListener("scroll",()=>{
    if(busy()||hold) return;
    if(!ready) measure();
    goal=rawP(); wake();
    clearTimeout(idleT);
    /* A stopped scroll inside the band finishes its own glide; mid-band is
       never a resting place (Yar caught it frozen mid-page). It finishes to
       the NEARER end, which it did not before: any scroll at all, even 30px,
       was committed to the corner capsule, so a nudge of the wheel sent the
       pill 550px across the foot and shrank it 360 to 118 in about 150ms —
       the jump Yar reported on 2026-10-29. A small scroll now settles back
       to the foot; the capsule is reached at half the band or more. */
    idleT=setTimeout(()=>{ goal=goal>=.5?1:0; wake(); },130);
  },{passive:true});
  addEventListener("resize",()=>{ clearTimeout(idleT); ready=false;
    if(!hold&&!busy()){ measure(); shown=goal=rawP(); place(shown); } },{passive:true});
  /* The rise starts once, from here. It used to start on `load` after a
     second measure and place, which put the card on screen at the foot and
     then restarted it from opacity 0 (Yar, 2026-10-20). */
  measure(); shown=goal=rawP(); placeOnce(shown);
  askSlot.classList.add("arrive");
  askSlot.addEventListener("animationend",e=>{ if(e.animationName==="askGrow") askSlot.classList.remove("arrive"); });

  // Home puts the card back at the foot from fresh measurements; the answer
  // pages clear it explicitly in go() and home() (releaseCard).
  askRestore = () => { hold=false; measure(); shown=goal=rawP(); place(shown); };

  // opens for the visitor, not for the typewriter writing a chip's question
  input.addEventListener("focus",()=>{ if(!askByMachine){ field.classList.remove("auto"); if(!busy()) openDock(); } });
  input.addEventListener("blur",()=>field.classList.remove("auto"));
  // A press inside the card keeps the field focused. Safari and Firefox do
  // not focus a link on click, so pressing a suggestion blurred the field,
  // the card closed under the pointer and the click landed on nothing.
  askCard.addEventListener("mousedown",e=>{ if(e.target!==input) e.preventDefault(); });
  // closing waits a beat, so a click already on its way still lands
  let closeT=null;
  const cancelClose=()=>{ clearTimeout(closeT); closeT=null; };
  askCard.addEventListener("focusin",cancelClose);
  askCard.addEventListener("focusout",e=>{
    if(askCard.contains(e.relatedTarget)) return;
    cancelClose();
    closeT=setTimeout(()=>{ closeT=null; if(!askCard.contains(document.activeElement) && !busy()) closeDock(); },120);
  });
  // the whole pill is the target, not only the input inside it
  askCard.addEventListener("pointerdown",e=>{
    if(!is("open") && e.target!==input){ e.preventDefault(); input.focus({preventScroll:true}); }
  });
})();

/* ============================================================
   THE SAME PILL UNDER AN ANSWER (2026-10-13)
   On answer pages, and on the homepage once it shows an answer, the card
   docks at the foot of the screen. Scrolled more than 64px down it becomes
   the homepage's pill (#promptblock.docked); back within 24px of the top it
   is the full dock again. Clicked, focused, or called with / or Cmd-K, the
   pill opens back into the full dock, and it returns to a pill when focus
   leaves while the page is still scrolled down. The dock's band (--dock-h,
   measured below) holds while the pill shows, so the page never reflows
   under it. Windows 560px tall or less keep the field in the flow.
   ============================================================ */
(function(){
  if(!askSlot || !askCard || !stage) return;
  const SHORT = window.matchMedia ? matchMedia("(max-height:560px)") : null;
  const DOWN = 64, UP = 24;
  const live = () => body.classList.contains("answered") && !body.classList.contains("leaving") && !body.classList.contains("returning");
  const isPill = () => askSlot.classList.contains("docked");
  let down = false;   // what the scroll position asks for
  function set(pill){
    if(!live()) return;
    if(pill && ((SHORT && SHORT.matches) || askCard.contains(document.activeElement))) pill = false;
    if(isPill() === pill) return;
    morph(() => askSlot.classList.toggle("docked", pill), [askCard], {duration:.42});
  }
  let queued = false;
  stage.addEventListener("scroll", () => {
    if(queued) return;
    queued = true;
    requestAnimationFrame(() => {
      queued = false;
      if(!live()) { down = false; return; }
      const y = stage.scrollTop;
      if(y > DOWN) down = true; else if(y < UP) down = false;
      set(down);
    });
  }, {passive:true});
  input.addEventListener("focus", () => { if(live() && isPill()) set(false); });
  askCard.addEventListener("focusout", e => {
    if(askCard.contains(e.relatedTarget)) return;
    setTimeout(() => { if(live() && down && !askCard.contains(document.activeElement)) set(true); }, 120);
  });
  // the whole pill is the target, not only the input inside it
  askCard.addEventListener("pointerdown", e => {
    if(live() && isPill() && e.target !== input){ e.preventDefault(); input.focus({preventScroll:true}); }
  });
  if(SHORT && SHORT.addEventListener) SHORT.addEventListener("change", () => {
    if(SHORT.matches && live() && isPill()) askSlot.classList.remove("docked");
    else if(!SHORT.matches) moveTo(wide(), askCard.contains(document.activeElement), true);
  });
})();

/* ============================================================
   FIXED FURNITURE MEASUREMENT
   The ask field docks to the bottom and the menu button floats at the top.
   Both are fixed over the scrolling stage, so the space they occupy is
   measured from the real elements and published as CSS variables. Nothing
   guesses; if the field grows, the stage shrinks to match.
   ============================================================ */
(function(){
  const root=document.documentElement;
  const pb=document.getElementById("promptblock");
  const toggle=document.getElementById("navtoggle");

  let fullDock=0;
  function measure(){
    let dock=0;
    if(pb && body.classList.contains("answered")){
      // The pill keeps the full dock's band, so the page under it never
      // reflows when the card changes shape on scroll.
      if(pb.classList.contains("docked") && fullDock) dock=fullDock;
      else {
        const r=pb.getBoundingClientRect();
        // height of the field plus the gap it keeps from the viewport bottom
        dock=fullDock=Math.round(r.height + Math.max(0, window.innerHeight - r.bottom) + 18);
      }
    }
    root.style.setProperty("--dock-h", dock+"px");

    // The masking band has to clear the LOWEST floating control, not just the
    // menu button. Back and Home sit 4px lower, so sizing off the toggle alone
    // left the heading ghosting through the fade as it scrolled past them.
    let header=0;
    if(toggle && getComputedStyle(toggle).display!=="none"){
      const bar=document.querySelector(".topbar");
      const lowest=Math.max(
        toggle.getBoundingClientRect().bottom,
        bar ? bar.getBoundingClientRect().bottom : 0
      );
      header=Math.round(lowest + 24);   // + room for the band to fade out in
    }
    root.style.setProperty("--header-h", header+"px");
  }

  measure();
  window.addEventListener("resize", measure, {passive:true});
  if(window.ResizeObserver && pb) new ResizeObserver(measure).observe(pb);
  // the dock only exists in the answered state, so re-measure when it changes
  new MutationObserver(measure).observe(body, {attributes:true, attributeFilter:["class"]});
  document.fonts && document.fonts.ready.then(measure);
})();

/* The stage's own scrollbar. Where scrollbars take room (Windows, or macOS
   with a mouse) it is 11px wide, and the solid Back and Home bar painted over
   the top of its thumb. --sbw is its width, so the bar, the phone band and the
   dock's fade stop short of it; 0 where scrollbars overlay the page. The
   content box shrinks when a scrollbar appears, so a ResizeObserver hears it.

   The bar also takes its own clicks now that it is solid, which would leave
   the wheel dead over it. The wheel is handed on to the stage. */
(function(){
  if(!stage) return;
  const root=document.documentElement;
  const sbw=()=>root.style.setProperty("--sbw", Math.max(0, stage.offsetWidth - stage.clientWidth) + "px");
  sbw();
  // html.scrolled draws the phone band's hairline once the stage is off the
  // top (WebKit held the scroll-timeline version at its end, line always on).
  const lift=()=>root.classList.toggle("scrolled", stage.scrollTop>0);
  stage.addEventListener("scroll", lift, {passive:true});
  lift();
  if(window.ResizeObserver) new ResizeObserver(sbw).observe(stage);
  else window.addEventListener("resize", sbw, {passive:true});
  const bar=document.querySelector(".topbar");
  if(bar) bar.addEventListener("wheel", e=>{
    if(e.ctrlKey || !body.classList.contains("answered")) return;   // pinch zoom, or a hidden bar
    const unit = e.deltaMode===1 ? 16 : e.deltaMode===2 ? stage.clientHeight : 1;
    stage.scrollBy({top:e.deltaY*unit, left:0, behavior:"instant"});
  }, {passive:true});
})();

/* ============================================================
   MOBILE NAVIGATION
   Toggles a class on <body>; the CSS translates the existing sidebar in.
   ============================================================ */
(function(){
  const toggle=document.getElementById("navtoggle");
  const side=document.querySelector(".side");
  if(!toggle||!side) return;
  const main=document.querySelector(".main");
  const skip=document.querySelector(".skiplink");
  const narrow=window.matchMedia ? window.matchMedia("(max-width:720px)") : null;

  /* Translating the panel off-canvas moves it out of sight, not out of the tab
     order: it stays visible:visible with twelve reachable controls sitting at
     x=-294. Closed, the panel is inert. Open, it is the only thing on screen, so
     everything behind it is inert instead, which is the focus trap. One property,
     both directions, and it takes the panel out of the accessibility tree too. */
  function syncInert(){
    const mobile = !narrow || narrow.matches;
    const open = body.classList.contains("nav-open");
    side.inert = mobile && !open;
    if(main) main.inert = mobile && open;
    if(skip) skip.inert = mobile && open;
  }

  function setOpen(open){
    body.classList.toggle("nav-open",open);
    toggle.setAttribute("aria-expanded",open?"true":"false");
    toggle.setAttribute("aria-label",open?"Close menu":"Open menu");
    syncInert();                                   // before focusing: inert blocks focus()
    if(open){ const first=side.querySelector("#nav a"); if(first) first.focus(); }
  }
  syncInert();

  toggle.addEventListener("click",()=>setOpen(!body.classList.contains("nav-open")));

  // a link, the scrim, or Escape all close it
  side.addEventListener("click",e=>{ if(e.target.closest("a")) setOpen(false); });
  document.addEventListener("click",e=>{
    if(!body.classList.contains("nav-open")) return;
    if(e.target.closest(".side")||e.target.closest(".navtoggle")) return;
    setOpen(false);
  });
  document.addEventListener("keydown",e=>{
    if(e.key==="Escape"&&body.classList.contains("nav-open")){ setOpen(false); toggle.focus(); }
  });

  // returning to a wide viewport must not leave the body scroll-locked, and must
  // not leave the sidebar inert once it is a permanent part of the page again
  if(narrow){
    const onChange=()=>{ if(!narrow.matches) setOpen(false); else syncInert(); };
    narrow.addEventListener ? narrow.addEventListener("change",onChange) : narrow.addListener(onChange);
  }
})();

/* ============================================================
   CAL.COM BOOKING
   Every trigger is a real link to cal.com first, so it works with JavaScript
   off and a crawler sees a genuine destination. The embed upgrades it to a
   popup in place, and booking never leaves the site.

   This used to bail unless a [data-cal-link] was already in the document,
   which broke the exact case it mattered in: answers are injected after load,
   so arriving anywhere and soft-navigating to one left the embed having
   decided there was nothing to upgrade, and every booking fell through to a
   full redirect. Cal's own delegation does handle injected triggers, so the
   embed loads once per session at idle instead, after first paint.
   ============================================================ */
const CAL_NS = "discovery";
(function(){
  function boot(){
    (function (C, A, L) {
      let p=function(a,ar){a.q.push(ar);}; let d=C.document;
      C.Cal=C.Cal||function(){ let cal=C.Cal; let ar=arguments;
        if(!cal.loaded){ cal.ns={}; cal.q=cal.q||[]; d.head.appendChild(d.createElement("script")).src=A; cal.loaded=true; }
        if(ar[0]===L){ const api=function(){p(api,arguments);}; const ns=ar[1]; api.q=api.q||[];
          if(typeof ns==="string"){cal.ns[ns]=cal.ns[ns]||api;p(cal.ns[ns],ar);p(cal,["initNamespace",ns]);}
          else p(cal,ar); return; }
        p(cal,ar); };
    })(window,"https://app.cal.com/embed/embed.js","init");
    Cal("init", CAL_NS, {origin:"https://cal.com"});
    Cal.ns[CAL_NS]("ui", {
      hideEventTypeDetails:false,
      layout:"month_view",
      theme: document.documentElement.dataset.theme === "light" ? "light" : "dark",
    });
  }
  // After first paint, never competing with it. By the time anyone reaches a
  // booking control it is ready, and if it somehow is not, the href still works.
  if("requestIdleCallback" in window) requestIdleCallback(boot, {timeout:2500});
  else setTimeout(boot, 1200);

  /* The trigger has to stay a real link with target="_blank": that is what works
     with JavaScript off and what a crawler follows. But the embed opens its modal
     without cancelling the click, so one tap produced both a popup and a new tab
     on all 38 triggers. Cancel the navigation only once the embed is actually
     there to replace it, so the fallback survives if it never loads. Capture
     phase, because Cal's own delegated handler may stop propagation. */
  document.addEventListener("click", e=>{
    if(e.button!==0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;  // let them open a tab on purpose
    if(!e.target.closest("[data-cal-link]")) return;
    // window.Cal, Cal.loaded and Cal.ns are all set by the inline stub before the
    // script has arrived, so none of them can tell us whether the embed is real.
    // The custom element is only defined once embed.js has actually run.
    if(customElements.get("cal-modal-box")) e.preventDefault();
  }, true);
})();

/* Keep the popup in the same theme as the site when the toggle is used. */
function syncCalTheme(mode){
  try{
    if(window.Cal && Cal.ns && Cal.ns[CAL_NS]) Cal.ns[CAL_NS]("ui",{theme: mode==="light" ? "light" : "dark"});
  }catch(e){}
}

/* light / dark / auto theme */
const lightMQ = window.matchMedia ? window.matchMedia("(prefers-color-scheme: light)") : null;
function systemTheme(){ return lightMQ && lightMQ.matches ? "light" : "dark"; }
function savedMode(){
  try{
    const v=localStorage.getItem("theme");
    return (v==="light"||v==="dark"||v==="auto") ? v : null;
  }catch(e){ return null; }
}
function applyMode(mode,persist){
  document.documentElement.dataset.theme = mode==="auto" ? systemTheme() : mode;
  document.documentElement.dataset.themeMode = mode;
  document.querySelectorAll("[data-theme-set]").forEach(x=>{
    x.setAttribute("aria-pressed",String(x.dataset.themeSet===mode));
  });
  // The key's glyph shows the current theme, so its label names the other one.
  const tb=document.getElementById("themer");
  if(tb) tb.setAttribute("aria-label",
    document.documentElement.dataset.theme==="light" ? "Switch to dark mode" : "Switch to light mode");
  if(persist!==false){ try{ localStorage.setItem("theme",mode); }catch(e){} }
  syncCalTheme(document.documentElement.dataset.theme);
  syncFilmTheme(document.documentElement.dataset.theme);
}
/* The hero film has one cut per theme. Setting the src attribute swaps it;
   load() made Chrome ignore preload="none" and fetch the other cut at page
   load. Paused part-way with its key, it loads the other cut to the same
   frame; off screen it waits for the next play. */
function syncFilmTheme(mode){
  const v=document.querySelector("video[data-hero-film]");
  if(!v) return;
  const dark=mode!=="light";
  const src="/site/media/film/hero-film"+(dark ? "-dark" : "")+".mp4";
  if(v.getAttribute("src")===src) return;
  const t=v.currentTime, playing=!v.paused;
  const poster=dark ? v.dataset.posterDark : v.dataset.posterLight;
  if(poster) v.setAttribute("poster",poster);
  v.preload = t>0 && !playing && v.dataset.held ? "metadata" : "none";
  v.setAttribute("src",src);
  if(t>0) v.addEventListener("loadedmetadata",()=>{ v.currentTime=t; },{once:true});
  if(playing){ const p=v.play(); if(p && p.catch) p.catch(()=>{}); }
}
/* Nothing animates until the saved theme has been applied.

   The first paint uses the OS preference, because the light theme lives in a
   media query so it does not depend on this file. When a visitor has saved a
   different theme, this script switches it a moment later — and every element
   carrying `transition:color` starts a transition on that switch. Those
   transitions never settle: they are left holding the pre-switch colour, so on
   a light-OS machine with dark saved, .chip and the footer links painted
   #4B4B48 on #0A0A0A. That is 2.26:1, against 7.81:1 intended.

   Measured on the live site 2026-08-08: 117 stranded transitions, chips at
   2.26:1. Forcing `transition:none` on the element snapped it to the correct
   #A3A3A0 immediately, which is what named the cause. */
(function(){
  const root = document.documentElement;
  root.classList.add("booting");
  applyMode(savedMode()||"auto",false);
  const settled = () => root.classList.remove("booting");
  // two frames, so the switched value is painted before transitions come back
  requestAnimationFrame(()=>requestAnimationFrame(settled));
  setTimeout(settled, 120);   // rAF does not fire in a background tab
})();
if(lightMQ){
  const onSystemChange=()=>{ if((savedMode()||"auto")==="auto") applyMode("auto",false); };
  if(lightMQ.addEventListener) lightMQ.addEventListener("change",onSystemChange);
  else if(lightMQ.addListener) lightMQ.addListener(onSystemChange);
}
/* Only a deliberate switch animates. applyMode also runs at boot, and letting
   that animate would turn a correct first paint into a 200ms fade. */
let themingT=null;
function themeSwitch(mode){
  const r=document.documentElement;
  r.classList.add("theming");
  applyMode(mode);
  clearTimeout(themingT);
  themingT=setTimeout(()=>r.classList.remove("theming"),260);
}
document.querySelectorAll("[data-theme-set]").forEach(b=>b.addEventListener("click",()=>{
  themeSwitch(b.dataset.themeSet);
}));
/* The key flips between explicit light and dark. It reads the RESOLVED theme,
   so from auto it lands on whichever one the system is not currently showing —
   the first press always visibly changes something. Auto is never reached by
   the key; the chip beside it is the way back. */
(function(){
  const t=document.getElementById("themer");
  if(t) t.addEventListener("click",()=>{
    themeSwitch(document.documentElement.dataset.theme==="light" ? "dark" : "light");
  });
})();



/* deep link on load */
(async function(){
  await loadIndex();
  INDEX.forEach(e=>ROUTES.add(e.path));
  buildDF();
  // Landing straight on an answer page: the server already sent the markup,
  // so adopt it instead of re-rendering. Avoids a flash and keeps this file
  // free of any second copy of the copy.
  if(answerEl && answerEl.dataset.q){
    const here = location.pathname.replace(/\/+$/,"") || "/";
    PAGES.set(here, {q: answerEl.dataset.q, html: answerEl.innerHTML});
    try{ history.replaceState({path:here,depth},""); }catch(e){}
    if(input){ input.value = answerEl.dataset.q; }
    if(field){ field.classList.add("on"); }
    setUrl(here,false);
    return;
  }
  // Landing straight on /ask: a shared or reloaded fallback, or the ask form
  // submitting with JavaScript off. The question is in the query string, which
  // is the whole point of moving this off /404, so read it from there and
  // render the state a soft navigation would have produced.
  if(location.pathname.replace(/\/+$/,"") === ASK_PATH){
    const q = (new URLSearchParams(location.search).get("q") || "").trim();
    const here = askUrl(q);
    try{ history.replaceState({path:here,depth},"",here); }catch(e){}
    if(input) input.value = q;
    if(field) field.classList.toggle("on", !!q);
    askSource = "url";
    // A shared or reloaded /ask?q= link is answered by the AI, exactly like the
    // same question typed into the field. It used to be short-circuited by the
    // local matcher, so one question got two different answers depending on
    // whether you typed it or arrived at its URL.
    if(q) applySuggestions(q);
    setUrl(here,false, q ? q + " | Yar" : document.title);
    return;
  }
  // Links shared while the router still used hashes land as "/#/contact". Move
  // them onto the real URL rather than leaving a second address for one page.
  const hashed = location.hash.slice(1);
  if(hashed && ROUTES.has(ALIAS[hashed]||hashed)){
    try{ history.replaceState({path:hashed,depth},"",hashed); }catch(e){}
    go(hashed,null,false);
    return;
  }
  try{ history.replaceState({path:"/",depth},""); }catch(e){}
  const p = location.pathname;
  if(p && p!=="/" && ROUTES.has(ALIAS[p]||p)){ go(p,null,false); }
  else setUrl("/",false,HOME_TITLE);
})();

/* ============================================================
   KEYBOARD NAVIGATION — arrow keys within the sidebar nav
   ============================================================ */
(function(){
  const nav=document.getElementById("nav");
  if(!nav) return;
  nav.addEventListener("keydown",e=>{
    const items=[...nav.querySelectorAll("a")];
    const i=items.indexOf(document.activeElement);
    if(i<0) return;
    let j=null;
    if(e.key==="ArrowDown"||e.key==="ArrowRight") j=(i+1)%items.length;
    else if(e.key==="ArrowUp"||e.key==="ArrowLeft") j=(i-1+items.length)%items.length;
    else if(e.key==="Home") j=0;
    else if(e.key==="End") j=items.length-1;
    if(j===null) return;
    e.preventDefault();
    items[j].focus();
  });
})();

/* ============================================================
   FLOWY DOWNLOAD — an email first, then the zip
   ============================================================ */
(function(){
  const form=document.getElementById("flowy-get"), open=document.getElementById("flowy-dl");
  if(!form||!open) return;
  // The form is in the markup so the gate works with scripts off. Here it
  // waits behind the button, and the button gives way to it on click.
  form.hidden=true;
  open.setAttribute("aria-expanded","false"); open.setAttribute("aria-controls","flowy-get");
  open.addEventListener("click",e=>{
    e.preventDefault();
    form.hidden=false; open.hidden=true; open.setAttribute("aria-expanded","true");
    const em=form.querySelector("input[type=email]"); if(em) em.focus();
  });
  form.addEventListener("submit",async e=>{
    e.preventDefault();
    const btn=form.querySelector("button[type=submit]"), status=form.querySelector(".getstatus");
    btn.disabled=true; if(status) status.textContent="";
    try{
      const res=await fetch(form.action,{method:"POST",headers:{"content-type":"application/json",accept:"application/json"},
        body:JSON.stringify({email:form.elements.email.value, website:form.elements.website.value, ref:document.referrer||null})});
      const out=await res.json().catch(()=>({}));
      if(!res.ok||!out.url) throw new Error(out.error||"failed");
      // GitHub serves the asset as an attachment, so assigning the URL starts
      // the download and leaves the page where it is.
      form.innerHTML='<p class="getdone">Downloading flowy.zip. If nothing arrived, <a href="'+out.url+'">here it is</a>.</p>';
      location.assign(out.url);
    }catch(err){
      btn.disabled=false;
      if(status) status.textContent=(err&&err.message==="email") ? "That address does not look right." : "That did not go through. Try again, or take the zip from the GitHub release.";
    }
  });
})();

/* ============================================================
   STATEMENTS AND THE WORK STRIP
   A statement's words light up as it scrolls through the screen. The
   words are wrapped here, so the sentence sits in the HTML whole; with
   scripts off, or with reduced motion, it is simply there in full ink.
   The work strip's bar shows how much of the strip is in view and where.
   ============================================================ */
(function(){
  const root=document.documentElement;
  const reduce=window.matchMedia && matchMedia("(prefers-reduced-motion:reduce)").matches;
  const stmts=[...document.querySelectorAll(".statement")];
  if(stmts.length && !reduce){
    const wrap=node=>{
      for(const n of [...node.childNodes]){
        if(n.nodeType===3){
          const frag=document.createDocumentFragment();
          n.textContent.split(/(\s+)/).forEach(part=>{
            if(!part) return;
            if(/^\s+$/.test(part)){ frag.appendChild(document.createTextNode(part)); return; }
            const w=document.createElement("span"); w.className="w"; w.textContent=part; frag.appendChild(w);
          });
          n.replaceWith(frag);
        } else if(n.nodeType===1) wrap(n);
      }
    };
    stmts.forEach(wrap);
    root.classList.add("split");
    let ticking=false;
    const paint=()=>{
      ticking=false;
      const vh=window.innerHeight;
      for(const el of stmts){
        const r=el.getBoundingClientRect();
        // lit from when the line enters the lower fifth until it reaches the upper third
        const p=Math.min(1,Math.max(0,(vh*0.85-r.top)/(vh*0.5+r.height*0.4)));
        const ws=el.querySelectorAll(".w"); const n=Math.round(p*ws.length);
        ws.forEach((w,i)=>w.classList.toggle("on",i<n));
      }
    };
    const onScroll=()=>{ if(!ticking){ ticking=true; requestAnimationFrame(paint); } };
    (stage||window).addEventListener("scroll",onScroll,{passive:true});
    window.addEventListener("resize",onScroll,{passive:true});
    paint();
  }

  const strip=document.getElementById("workstrip");
  const bar=document.querySelector(".stripbar");
  if(strip && bar){
    const upd=()=>{
      const w=strip.clientWidth/strip.scrollWidth;
      bar.style.setProperty("--w",(w*100)+"%");
      bar.style.setProperty("--x",(strip.scrollLeft/strip.clientWidth*100)+"%");
    };
    strip.addEventListener("scroll",upd,{passive:true});
    window.addEventListener("resize",upd,{passive:true});
    upd();
    // Chrome scrolls a focused link into the strip only when it is wholly
    // outside, so Tab left half-shown links cut at the edge. Keyboard focus
    // brings the card in; a mouse press is left alone, or the click is lost.
    strip.addEventListener("focusin",e=>{
      const card=e.target.closest(".proof");
      if(!card || !e.target.matches(":focus-visible")) return;
      const s=strip.getBoundingClientRect(), r=e.target.getBoundingClientRect();
      if(r.left-4<s.left || r.right+4>s.right){
        strip.scrollTo({left:strip.scrollLeft+card.getBoundingClientRect().left-s.left,
          behavior:(REDUCED && REDUCED.matches) ? "instant" : "smooth"});
      }
    });
  }
})();

/* ============================================================
   VIDEOS: CLIENT PREVIEWS AND PROJECT RECORDINGS
   Every clip on screen plays (Yar, 2026-10-13: "it should all preview when
   I scroll to that section"), which reverses the one-clip rule of
   2026-10-12. A clip plays from its first pixel on screen and, once wholly
   off screen, pauses and goes back to its first frame, which is its poster
   (tools/promos checks that the two match), so it is ready the next time
   it comes in. preload="none" keeps the first screen light; half a screen
   before a clip arrives its preload turns to auto, so it is already moving
   when it shows. Reduced motion and data saver keep the posters, and the
   pause control goes with them. A .vidpause button holds the clips its
   data-pause selector names until it is pressed again: autoplaying loops
   that run longer than five seconds need a way to stop them (WCAG 2.2.2).
   The hero's film (video[data-hero-film]) follows the same rules; its key
   has no words, so it keeps its aria-label and only aria-pressed changes.
   ============================================================ */
(function(){
  const vids=[...document.querySelectorAll(".cwvid video, .pjvid video, video[data-hero-film]")];
  if(!vids.length) return;
  const reduce=window.matchMedia && matchMedia("(prefers-reduced-motion:reduce)").matches;
  const saveData=navigator.connection && navigator.connection.saveData;
  if(reduce || saveData || !("IntersectionObserver" in window)){ document.documentElement.classList.add("vidstill"); return; }
  const shown=new Set();
  const play=v=>{ if(v.dataset.held || document.hidden) return; const p=v.play(); if(p && p.catch) p.catch(()=>{}); };
  // off screen: stop, and back to the first frame unless the pause button
  // holds it where it stopped
  const rest=v=>{ v.pause(); if(!v.dataset.held && v.currentTime>0) v.currentTime=0; };
  const io=new IntersectionObserver(entries=>{
    entries.forEach(en=>{
      if(en.isIntersecting){ shown.add(en.target); play(en.target); }
      else { shown.delete(en.target); rest(en.target); }
    });
  },{root:stage||null,threshold:0});
  const warm=new IntersectionObserver(entries=>{
    entries.forEach(en=>{ if(en.isIntersecting){ en.target.preload="auto"; warm.unobserve(en.target); } });
  },{root:stage||null,rootMargin:"50% 0px"});
  vids.forEach(v=>{ io.observe(v); warm.observe(v); });
  document.addEventListener("visibilitychange",()=>{
    if(document.hidden) vids.forEach(v=>v.pause()); else shown.forEach(play);
  });
  document.querySelectorAll(".vidpause").forEach(btn=>{
    const label=btn.textContent.replace(/^(Pause|Play)\s*/,"");
    const worded=!!btn.textContent.trim();
    btn.addEventListener("click",()=>{
      const hold=btn.getAttribute("aria-pressed")!=="true";
      btn.setAttribute("aria-pressed", String(hold));
      if(worded) btn.textContent=(hold ? "Play" : "Pause") + (label ? " " + label : "");
      document.querySelectorAll(btn.dataset.pause).forEach(v=>{
        if(hold){ v.dataset.held="1"; v.pause(); }
        else { delete v.dataset.held; if(shown.has(v)) play(v); else rest(v); }
      });
    });
  });
})();

/* ============================================================
   FOOTER WORDMARK LANE
   The theme key is fixed to the bottom right. At widths where the content
   column runs under it (1024 to about 1590 px, and phone answer pages), the
   key would cover the wordmark's last letter or crowd it, so the overlap
   plus a 24px clearance goes into --fn-lane and the stylesheet shrinks the
   wordmark by exactly that much.
   Measured, not guessed: the key moves between pages and on the homepage.
   ============================================================ */
(function(){
  const name=document.querySelector(".footname"), key=document.querySelector(".themedock");
  if(!name || !key) return;
  const set=()=>{
    const col=name.parentElement.getBoundingClientRect(), k=key.getBoundingClientRect();
    const atBottom = k.width>0 && k.top > innerHeight/2;
    // keep the wordmark 24px clear of the key wherever the key sits within 24px of it
    const lane = atBottom && col.right > k.left - 24 ? Math.ceil(col.right - (k.left - 24)) : 0;
    document.documentElement.style.setProperty("--fn-lane", lane + "px");
  };
  set();
  addEventListener("resize", set);
  // the key changes place when an answer docks the field on the homepage
  new MutationObserver(()=>setTimeout(set, 700)).observe(document.body, {attributes:true, attributeFilter:["class"]});
})();


/* The recommendations slider on the homepage: one track moved by transform,
   three slides, a seven-second rhythm that waits while the pointer or focus
   is inside it and never runs under reduced motion. */
(function(){
  const root = document.querySelector("[data-qslider]");
  if(!root) return;
  const track = root.querySelector(".qtrack");
  const slides = [...track.children];
  const dots = [...root.querySelectorAll("[data-q-dot]")];
  const REDUCED = window.matchMedia ? window.matchMedia("(prefers-reduced-motion: reduce)") : null;
  const N = slides.length;
  let i = 0, timer = null;

  /* The slides share one grid cell. The incoming quote decodes: each
     character starts as a random glyph and locks in from the left, spaces
     first. The text in the HTML is the final state, so a crawler or a
     copy-paste sees the quote whole. */
  const quotes = slides.map(s => s.querySelector("blockquote p"));
  quotes.forEach(p => { p.dataset.text = p.textContent; });
  /* Each attribution sits directly under its own quote. The track keeps the
     height of the tallest slide plus one line, so a glyph in mid-decode that
     wraps onto an extra line does not move the dots below. */
  function fixHeight(){
    track.style.minHeight = "";
    const h = Math.max(...slides.map(s => s.getBoundingClientRect().height));
    const line = parseFloat(getComputedStyle(quotes[0]).lineHeight) || 0;
    track.style.minHeight = Math.ceil(h + line) + "px";
  }
  fixHeight();
  new ResizeObserver(fixHeight).observe(root);
  if(document.fonts && document.fonts.ready) document.fonts.ready.then(fixHeight);
  const GLYPHS = "!<>-_\\/[]{}=+*^?#ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  let run = 0;

  function decode(p, text, token){
    const chars = [...text], n = chars.length, t0 = performance.now(), DUR = 700;
    return new Promise(done => {
      const frame = now => {
        if(token !== run){ p.textContent = text; return done(); }
        const t = Math.min(1, (now - t0) / DUR);
        let out = "";
        for(let k = 0; k < n; k++){
          out += (/\s/.test(chars[k]) || t >= 0.1 + 0.7 * (k / n)) ? chars[k] : GLYPHS[Math.random() * GLYPHS.length | 0];
        }
        p.textContent = out;
        if(t < 1) requestAnimationFrame(frame); else { p.textContent = text; done(); }
      };
      requestAnimationFrame(frame);
    });
  }
  function go(n, animate = true){
    i = (n + N) % N;
    slides.forEach((s, k) => {
      s.classList.toggle("is-on", k === i);
      s.setAttribute("aria-hidden", k === i ? "false" : "true");
    });
    dots.forEach((d, k) => d.setAttribute("aria-selected", k === i ? "true" : "false"));
    const token = ++run;
    if(!animate || (REDUCED && REDUCED.matches)){
      quotes.forEach(p => { p.textContent = p.dataset.text; });
      return;
    }
    decode(quotes[i], quotes[i].dataset.text, token);
  }
  function stop(){ clearInterval(timer); timer = null; }
  function start(){
    stop();
    if(REDUCED && REDUCED.matches) return;
    timer = setInterval(() => go(i + 1), 7000);
  }
  dots.forEach((d, k) => d.addEventListener("click", () => { go(k); start(); }));
  root.addEventListener("mouseenter", stop);
  root.addEventListener("mouseleave", start);
  root.addEventListener("focusin", stop);
  root.addEventListener("focusout", start);
  go(0, false);
  start();
})();

/* ============================================================
   STATEMENT MARQUEE WIDTH
   The client marquee under the headline is as wide as the headline's
   widest line, so the two share one left and one right edge. The line
   widths come from the text's own line boxes, so this follows the font
   and the viewport; below 721px the headline is one column and the
   marquee takes the full width.
   ============================================================ */
(function(){
  const head=document.querySelector(".stmt-split .statement");
  const marquee=document.querySelector(".stmt-split .stmt-marquee");
  if(!head || !marquee) return;
  const fit=()=>{
    if(window.matchMedia("(max-width:720px)").matches){ marquee.style.width=""; return; }
    const range=document.createRange();
    range.selectNodeContents(head);
    const lines={};
    for(const r of range.getClientRects()){
      if(!r.width) continue;
      const k=Math.round(r.top/10);
      const l=lines[k]||(lines[k]={left:r.left,right:r.right});
      l.left=Math.min(l.left,r.left); l.right=Math.max(l.right,r.right);
    }
    let widest=0;
    for(const k in lines) widest=Math.max(widest,lines[k].right-lines[k].left);
    if(widest) marquee.style.width=Math.ceil(widest)+"px";
  };
  fit();
  if(document.fonts && document.fonts.ready) document.fonts.ready.then(fit);
  if("ResizeObserver" in window) new ResizeObserver(fit).observe(head.parentElement);
  else window.addEventListener("resize", fit);
})();

/* ============================================================
   CLIENT MARQUEE
   The strip drifts, and a reader can take hold of it: drag, let go, and it
   carries on with the momentum of the throw before settling back into the
   drift. A pointer over it holds it still so a logo's tip can be read. A
   logo is a link; its tip is one shared element on the body, placed from
   the logo's rectangle. Only transform moves, the loop runs while the strip
   is moving and on screen, and it stops when it is still.
   ============================================================ */
(function(){
  const marquee = document.querySelector(".stmt-marquee");
  if(!marquee) return;
  const track = marquee.querySelector(".stmt-track");
  const items = [...track.children];
  const REDUCED = window.matchMedia ? window.matchMedia("(prefers-reduced-motion: reduce)") : null;
  const DRIFT_MS = 40000;   // one cycle, as the old keyframes had it
  const TAU = 420;          // ms for a throw to settle back into the drift
  const SLOP = 6;           // px of travel before a press is a drag, not a click

  /* the tip is itself a link to the same site, so the pointer can travel
     onto it and click it; the keyboard already reaches the logo's link */
  const tip = document.createElement("a");
  tip.className = "stmt-tip";
  tip.target = "_blank";
  tip.rel = "noopener";
  tip.tabIndex = -1;
  tip.setAttribute("aria-hidden", "true");
  document.body.appendChild(tip);
  const HIDE_MS = 180;      // grace for the pointer to cross the gap to the tip

  let half = 0;             // px width of one copy of the list
  let drift = 0;            // px per ms; negative drifts left
  let x = 0, v = 0, last = 0, raf = 0, inView = true;
  let dragging = false, pid = null, lastX = 0, lastT = 0, travel = 0;
  let hovering = false, tipHover = false, focused = false, active = null, hideT = 0;

  const reduced = () => REDUCED && REDUCED.matches;
  const held = () => hovering || tipHover || focused;
  const wrap = p => { if(!half) return 0; p %= half; return p > 0 ? p - half : p; };
  const apply = () => { track.style.transform = `translate3d(${x}px,0,0)`; };

  function measure(){
    half = items.length > 1 && items[items.length / 2] ? items[items.length / 2].offsetLeft : 0;
    drift = reduced() || !half ? 0 : -half / DRIFT_MS;
    x = wrap(x);
    apply();
    schedule();
  }

  function schedule(){ if(!raf) raf = requestAnimationFrame(step); }

  function step(now){
    raf = 0;
    const dt = last ? Math.min(48, now - last) : 0;
    last = now;
    if(!dragging){
      const target = held() ? 0 : drift;
      v += (target - v) * (1 - Math.exp(-dt / TAU));
      if(Math.abs(v - target) < 1e-6) v = target;
      x = wrap(x + v * dt);
      apply();
    }
    if(active) placeTip(active);
    const moving = dragging || v !== 0 || (!held() && drift !== 0);
    if(inView && moving) schedule();
    else last = 0;
  }

  function placeTip(a){
    const r = a.getBoundingClientRect();
    const tw = tip.offsetWidth, th = tip.offsetHeight;
    let top = r.top - th - 10;
    const below = top < 8;
    if(below) top = r.bottom + 10;
    const left = Math.max(8, Math.min(innerWidth - tw - 8, r.left + r.width / 2 - tw / 2));
    tip.style.transform = `translate3d(${Math.round(left)}px,${Math.round(top)}px,0)`;
  }
  function showTip(a){
    clearTimeout(hideT);
    active = a;
    tip.textContent = a.dataset.tip;
    tip.href = a.href;
    tip.classList.add("is-on");
    placeTip(a);
  }
  function hideTip(){
    clearTimeout(hideT);
    active = null;
    tipHover = false;
    tip.classList.remove("is-on");
  }
  /* leaving a logo or the strip waits a moment, so the pointer can reach the tip */
  function hideSoon(){
    clearTimeout(hideT);
    hideT = setTimeout(() => { hideTip(); schedule(); }, HIDE_MS);
  }

  /* drag: the strip follows the pointer and keeps a running velocity */
  function onMove(e){
    if(e.pointerId !== pid) return;
    const dx = e.clientX - lastX, dt = e.timeStamp - lastT;
    lastX = e.clientX; lastT = e.timeStamp;
    travel += Math.abs(dx);
    if(travel > SLOP) marquee.classList.add("is-drag");
    x = wrap(x + dx);
    if(dt > 0) v = v * 0.6 + (dx / dt) * 0.4;
    apply();
  }
  function onUp(e){
    if(e && e.pointerId !== pid) return;
    dragging = false;
    pid = null;
    marquee.classList.remove("is-drag");
    window.removeEventListener("pointermove", onMove);
    window.removeEventListener("pointerup", onUp);
    window.removeEventListener("pointercancel", onUp);
    v = Math.max(-1.5, Math.min(1.5, v));   // cap the throw so a flick cannot fling it
    schedule();
  }
  marquee.addEventListener("pointerdown", e => {
    if(e.button !== 0) return;
    dragging = true;
    pid = e.pointerId;
    lastX = e.clientX;
    lastT = e.timeStamp;
    travel = 0;
    v = 0;
    hideTip();
    window.addEventListener("pointermove", onMove, { passive: true });
    window.addEventListener("pointerup", onUp);
    window.addEventListener("pointercancel", onUp);
  }, { passive: true });

  /* a press that moved is a drag, so the link it started on does not open */
  marquee.addEventListener("click", e => {
    if(travel > SLOP){ e.preventDefault(); e.stopPropagation(); }
  }, true);
  marquee.addEventListener("dragstart", e => e.preventDefault());

  /* hover holds the strip still and shows the tip for the logo under it */
  marquee.addEventListener("pointerenter", e => {
    if(e.pointerType !== "mouse") return;
    hovering = true;
    schedule();
  });
  marquee.addEventListener("pointerleave", e => {
    if(e.pointerType !== "mouse") return;
    hovering = false;
    hideSoon();
    schedule();
  });
  marquee.addEventListener("pointerover", e => {
    if(e.pointerType !== "mouse" || dragging) return;
    const a = e.target.closest(".stmt-logo");
    if(a) showTip(a);
  });
  marquee.addEventListener("pointerout", e => {
    const a = e.target.closest(".stmt-logo");
    if(a && !a.contains(e.relatedTarget)) hideSoon();
  });
  /* the tip keeps the strip held and the tip up while the pointer is on it */
  tip.addEventListener("pointerenter", e => {
    if(e.pointerType !== "mouse") return;
    clearTimeout(hideT);
    tipHover = true;
    schedule();
  });
  tip.addEventListener("pointerleave", e => {
    if(e.pointerType !== "mouse") return;
    tipHover = false;
    hideSoon();
    schedule();
  });

  /* keyboard: a focused logo is brought to the middle and holds the strip */
  marquee.addEventListener("focusin", e => {
    const a = e.target.closest(".stmt-logo");
    if(!a || !a.matches(":focus-visible")) return;
    focused = true;
    const cr = marquee.getBoundingClientRect(), lr = a.getBoundingClientRect();
    const c = lr.left + lr.width / 2 - cr.left;
    if(c < 0 || c > cr.width){ x = wrap(x + cr.width / 2 - c); apply(); }
    showTip(a);
    schedule();
  });
  marquee.addEventListener("focusout", () => {
    focused = false;
    hideTip();
    schedule();
  });
  /* a focused link past the edge can make the box scroll; the track is the only mover */
  marquee.addEventListener("scroll", () => { marquee.scrollLeft = 0; }, { passive: true });

  new ResizeObserver(measure).observe(track);
  if(document.fonts && document.fonts.ready) document.fonts.ready.then(measure);
  if(REDUCED && REDUCED.addEventListener) REDUCED.addEventListener("change", measure);
  if("IntersectionObserver" in window){
    new IntersectionObserver(([entry]) => { inView = entry.isIntersecting; if(inView) schedule(); }).observe(marquee);
  }
  measure();
})();

/* The hero booking button's pointer-following highlight was removed with the
   glass pill it lit (2026-10-27). It is now a flat green fill, so there is no
   gradient to move. */

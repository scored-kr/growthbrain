import {compareFirstSentenceReply, isFirstSentenceEdit, needsContext, type ContextResult, type Service} from './memory.ts';
import {chatRoute, claudeTurnBaseline, claudeUserId, completedClaudeReply, composer, editorText, initialCaptureTranscript, lastUserNode, noticeAnchor, sendButton, setEditorText, renderedTranscript, transcriptFrames, type Editor} from './adapters.ts';
import {CaptureRouteGuard} from './capture-route.ts';
import {resumePrompt as recallInstruction} from './recall-command.ts';
import {maxCaptureBatchTurns, maxCaptureBatchUnits} from './capture-batch.ts';
import {ComposerNotice, type NoticeView} from './notice.ts';

type Found = Extract<ContextResult, {status: 'found'}>;
type Lookup = ContextResult | {status: 'denied'};
type Receipt = {expected: string; previous?: HTMLElement; started: number; warned?: boolean};
type Sent = {request: Request; record: Found; delivered: boolean; moving?: boolean; receipt?: Receipt};
type Request = {route: string; question: string; projectId?: string};
type Comparison = { request: Request; base: Found; expected: string; baseline: string[]; userId?: string; replyId?: string };
const unverified = {status:'unverified'} as const;
const marker = '\n\n〔Growth Brain 승인 원고 · ';
const recallCommand = /^\/gb(?:\s+([\s\S]*))?$/i;
type CaptureScan = {observed:number; readable:number; routeUnverified?:boolean};
const ask = <T>(message: Record<string, unknown>): Promise<T> => chrome.runtime.sendMessage(message);

function start(service: Service) {
  const page = () => chatRoute(service, location.pathname);
  const notice = new ComposerNotice();
  let route = page();
  const captureRoute = new CaptureRouteGuard(route);
  let grants = {capture: false, share: false, guard: false};
  let loading: Promise<void> | undefined;
  let awaitingSubmit = false;
  let inputChanges = 0;
  let epoch = 0;
  let active = true;
  let composing = false;
  let dispatching = false;
  let busy = false;
  let view: NoticeView | undefined;
  let held: Request | undefined;
  let sent: Sent | undefined;
  let savedDraft: Request | undefined;
  let comparison: Comparison | undefined;
  let committing: Promise<CaptureScan | false> = Promise.resolve(false);
  let lastCapture: {epoch:number; routeGeneration:number; scan:CaptureScan | false} | undefined;
  let timer = 0;
  let scheduledScan = false;
  let changedDuringScan = false;
  let generation = 0;
  const captured = new Map<string,string>();

  function hide() { view = undefined; notice.close(); }
  function dismiss() { sent = undefined; hide(); }
  function show(model: Omit<NoticeView,'close'>) {
    view = {...model, close: dismiss};
    notice.render(view);
    mount();
  }
  function mount() {
    if (!view) return;
    const editor = composer(service);
    if (editor && page() === route) notice.mount(noticeAnchor(editor));
  }
  function valid(req: Request, id: number) { return active && id === epoch && page() === req.route; }
  function save(route: string, text: string) {
    void ask({type:'saveDraft', conversationId:route,text}).catch(() => {});
  }
  async function restore(expected: string | undefined) {
    if (!expected || !active || !(grants.capture || grants.share)) return;
    const id = epoch;
    const draft = await ask<{text?:string}>({type:'draft',conversationId:expected}).catch(() => undefined);
    if (draft?.text && id === epoch && expected === page()) {
      savedDraft = {route:expected,question:draft.text};
      applySavedDraft();
    }
  }
  function applySavedDraft() {
    if (!savedDraft || savedDraft.route !== page()) return;
    const input = composer(service);
    if (!input) return; // A composer may mount well after document_start.
    const req = savedDraft;
    savedDraft = undefined;
    if (!editorText(input) && setEditorText(input,req.question)) held = req;
  }
  async function lookup(req: Request): Promise<Lookup> {
    try {
      const response = await ask<Lookup>({type:'lookup',conversationId:req.route,query:req.question,projectId:req.projectId});
      return response?.status ? response : {status:'missing'};
    } catch { return {status:'missing'}; }
  }

  function blocked(req: Request, result: Exclude<Lookup,Found>) {
    const option = req.question.match(/([1-9]\d?)\s*안/u)?.[1];
    const name = option ? `${option}안` : '원고';
    const retry = (projectId?: string) => {
      const input = composer(service);
      if (!input || editorText(input) !== req.question || page() !== req.route) { hide(); return; }
      void prepare(input, {...req,projectId: projectId ?? req.projectId}, false);
    };
    if (result.status === 'ambiguous') {
      show({label:'어느 프로젝트의 원고인가요?', actions:result.projects.map(p => ({label:p.title,run:() => retry(p.projectId)}))});
    } else {
      show({label:result.status === 'denied' ? '이 서비스에 원고를 전달할 권한이 필요해요.' : `${option ? name + ' 원고를' : '원고를'} 불러오지 못했어요. 질문은 입력창에 있어요.`,
        actions:[{label:`${name} 다시 불러오기`,run:() => retry()}]});
    }
  }

  function fallback(expanded = false, detail?: string) {
    const pending = sent;
    if (!pending || pending.delivered || pending.moving) return;
    const {option, text} = pending.record;
    show({label:`${option}안 조회 미확인 ${expanded ? '⌃' : '⌄'}`, expanded,
      toggle:() => { if (expanded) fallback(); else void openPreview(pending); },
      preview:expanded ? text : undefined, body:expanded ? detail : undefined,
      actions:expanded ? [{label:`${option}안과 함께 다시 보내기`,primary:true,run:() => { void resend(); }},
        {label:'원고 빼기',run:dismiss}] : undefined});
  }

  async function openPreview(pending: Sent) {
    const id = epoch;
    const req = pending.request;
    const fresh = await lookup({...req,projectId:pending.record.projectId});
    if (!valid(req,id) || sent !== pending || pending.delivered) return;
    if (fresh.status !== 'found') {
      dismiss(); show({label:'승인된 원고를 다시 불러오지 못했어요.'}); return;
    }
    pending.record = fresh;
    fallback(true);
  }

  function clickSend(input: Editor): boolean {
    const button = sendButton(service,input);
    if (!button || button.disabled || button.getAttribute('aria-disabled') === 'true') return false;
    dispatching = true;
    try { button.click(); } finally { dispatching = false; }
    return true;
  }
  function watchReceipt(pending: Sent) {
    const receipt = pending.receipt;
    if (!receipt || pending !== sent || !active || page() !== pending.request.route) return;
    const current = lastUserNode(service);
    if (current && current !== receipt.previous && current.innerText === receipt.expected) {
      if (comparison?.request === pending.request && comparison.expected === receipt.expected) {
        comparison.userId = claudeUserId(current);
      }
      delete pending.receipt;
      pending.moving = false;
      if (pending.delivered) hide();
      else fallback();
      return;
    }
    if (Date.now() - receipt.started < 3500 || receipt.warned || pending.moving) return;
    receipt.warned = true;
    const restoreText = () => {
      if (sent !== pending || page() !== pending.request.route) return;
      const editor = composer(service);
      if (!editor || editorText(editor) && editorText(editor) !== receipt.expected) {
        show({label:'작성 중인 답장이 있어요. 전송 기록을 먼저 확인해 주세요.'}); return;
      }
      if (!editorText(editor)) setEditorText(editor,receipt.expected);
      show({label:'대화에 같은 메시지가 있는지 확인한 뒤 서비스 보내기 버튼을 눌러 주세요.'});
    };
    show({label:'채팅에서 전송을 확인하지 못했어요. 전송 기록을 확인해 주세요.',
      actions:[{label:'입력창에 원문 복구',run:restoreText}]});
  }
  function track(pending: Sent, expected: string) {
    pending.receipt = {expected, previous:lastUserNode(service), started:Date.now()};
    window.setTimeout(() => watchReceipt(pending),3600);
  }
  function trackComparison(pending: Sent, expected: string) {
    comparison = undefined;
    if (service !== 'claude' || !grants.capture || !grants.share || pending.record.sourceService !== 'chatgpt' ||
        !isFirstSentenceEdit(pending.request.question)) return;
    const baseline = claudeTurnBaseline();
    if (baseline) comparison = {request:pending.request, base:pending.record, expected, baseline};
  }
  async function compareReply() {
    const check = comparison;
    if (loading || !active || !grants.capture || !grants.share || !check?.userId ||
        !route || route === 'new' || page() !== route || check.request.route !== route) return unverified;
    const id = epoch;
    const current = completedClaudeReply(check.baseline,check.userId,check.expected);
    if (!current || check.replyId && check.replyId !== current.id) return unverified;
    const {projectId, option, version} = check.base;
    const approved = await ask<{ok:boolean}>({type:'checkApproved',conversationId:route,projectId,option,version});
    if (!approved?.ok || comparison !== check || !valid(check.request,id) || !grants.capture || !grants.share) return unverified;
    const final = completedClaudeReply(check.baseline,check.userId,check.expected);
    if (!final || final.id !== current.id || final.text !== current.text) return unverified;
    check.replyId = final.id;
    const status = compareFirstSentenceReply(check.base.text,final.text);
    return status === 'unverified' ? unverified : {status,option,version};
  }
  async function resend() {
    const pending = sent;
    const input = composer(service);
    if (busy || !input || !pending || pending.delivered || pending.moving || pending.receipt || !grants.share) return;
    const id = epoch;
    if (editorText(input)) { fallback(true,'작성 중인 답장이 있어요. 입력창을 비운 뒤 다시 보내세요.'); return; }
    busy = true;
    try {
      const req = pending.request;
      const record = await lookup({...req,projectId:pending.record.projectId});
      if (!valid(req,id) || pending !== sent || composer(service) !== input || editorText(input)) return;
      if (record.status !== 'found') {
        dismiss(); show({label:'승인된 원고를 다시 읽을 수 없어 전송을 멈췄어요.'}); return;
      }
      if (record.version !== pending.record.version || record.text !== pending.record.text || record.option !== pending.record.option) {
        pending.record = record; fallback(true,'원고가 변경되었어요. 새 버전을 확인해 주세요.'); return;
      }
      const combined = `${req.question}${marker}${record.option}안 v${record.version}〕\n${record.text}`;
      if (!setEditorText(input,combined)) {
        show({label:'입력창에 원고를 준비하지 못했어요. 내용을 확인해 주세요.'}); return;
      }
      // Editors can enable their send button on the next React render. Wait only
      // for that local control. A dispatched click is never automatically retried.
      await new Promise(resolve => setTimeout(resolve,50));
      if (!valid(req,id) || sent !== pending) return;
      if (composer(service) !== input || editorText(input) !== combined) {
        fallback(true,'입력창이 바뀌었어요. 작성 중인 내용을 확인해 주세요.'); return;
      }
      pending.delivered = true;
      track(pending,combined);
      trackComparison(pending,combined);
      if (!clickSend(input)) {
        comparison = undefined;
        delete pending.receipt;
        show({label:'질문과 원고를 입력창에 준비했어요. 서비스 보내기 버튼을 눌러 주세요.'});
      } else { show({label:'채팅에서 전송을 확인하고 있어요.'}); watchReceipt(pending); }
    } finally { busy = false; }
  }

  async function prepare(input: Editor, req: Request, submit: boolean) {
    if (busy) return;
    const id = epoch;
    busy = true;
    try {
      // A user can submit a follow-up immediately after confirming the choice.
      await capture();
      if (!valid(req,id) || input !== composer(service) || editorText(input) !== req.question) return;
      const result = await lookup(req);
      if (!valid(req,id) || input !== composer(service) || editorText(input) !== req.question) return;
      if (result.status !== 'found') {
        held = req; save(req.route, req.question); blocked(req,result); return;
      }
      held = {...req,projectId:result.projectId};
      if (!submit) { show({label:`${result.option}안을 찾았어요. 입력창에서 질문을 보내세요.`}); return; }
      // The first send uses the user's question exactly. The service decides
      // whether to call get_context. Local preflight is never a tool receipt.
      const pending: Sent = {request:{...held},record:result,delivered:false};
      track(pending,req.question);
      trackComparison(pending,req.question);
      held = undefined;
      save(req.route,''); // Clear the new-page slot before native SPA navigation.
      sent = pending;
      if (!clickSend(input)) {
        sent = undefined; comparison = undefined; held = pending.request;
        save(req.route,req.question); show({label:'보내기 버튼을 사용할 수 없어요. 질문은 입력창에 있어요.'}); return;
      }
      schedule();
    } finally { busy = false; }
  }

  function handleSubmit(input: Editor, pause: () => void): boolean {
    if (!grants.guard) return false;
    const current = page();
    if (!current) return false;
    const question = editorText(input);
    if (current === 'new' && grants.capture) captureRoute.firstSubmit(question, transcriptFrames(service));
    const command = recallCommand.exec(question.trim());
    if (command) {
      pause();
      if (!grants.share) {
        show({label:'이 사이트에서 /gb를 쓰려면 확장 팝업에서 AI 전달을 켜세요. 입력한 요청은 그대로 있어요.'});
        return true;
      }
      held = undefined;
      comparison = undefined;
      dismiss();
      const task = command[1]?.trim() || '지난번 정한 조건대로 다음 작업을 진행해줘.';
      const expanded = recallInstruction + '\n\n' + task;
      const complete = setEditorText(input,expanded);
      show({label:complete ? 'MCP 조회를 요청하는 문구를 넣었어요. 확인하고 보내세요. 이 채팅에 Growth Brain MCP가 연결돼 있어야 해요.'
        : '입력창에 요청을 완성하지 못했어요. 작성 중인 글을 확인해 주세요.'});
      return true;
    }
    if (!question.trim() || question.startsWith(recallInstruction) || !needsContext(question) || question.includes(marker)) {
      if (question.trim()) { comparison = undefined; dismiss(); held = undefined; save(current,''); }
      return false;
    }
    pause();
    submitContext(input);
    return true;
  }
  function intercept(event: Event, input: Editor) {
    if (dispatching || !event.isTrusted || !page()) return;
    const pause = () => { event.preventDefault(); event.stopImmediatePropagation(); };
    if (!loading) { handleSubmit(input,pause); return; }
    // document_start may receive a submit while we are still reading site consent.
    pause();
    if (awaitingSubmit) return;
    awaitingSubmit = true;
    const target = page(), edits = inputChanges;
    void loading.then(() => {
      awaitingSubmit = false;
      if (!active || page() !== target || composer(service) !== input || edits !== inputChanges) return;
      if (!handleSubmit(input,() => {})) clickSend(input);
    });
  }
  function submitContext(input: Editor) {
    const current = page();
    if (!current) return;
    const question = editorText(input);
    if (busy || sent?.receipt && sent.receipt.expected === question && !sent.receipt.warned) return;
    comparison = undefined; dismiss();
    const req = held?.route === current && held.question === question ? held : {route:current,question};
    void prepare(input,req,true);
  }
  let composingEnded = false;
  window.addEventListener('compositionstart', () => { composing = true; },true);
  window.addEventListener('compositionend', () => {
    composing = false; composingEnded = true;
    window.setTimeout(() => { composingEnded = false; },0);
  },true);
  window.addEventListener('keydown', event => {
    if (event.key !== 'Enter' || event.shiftKey || event.altKey || event.ctrlKey || event.metaKey ||
        event.defaultPrevented || event.isComposing || composing || composingEnded || event.keyCode === 229) return;
    const input = composer(service);
    if (input && event.target instanceof Node && input.contains(event.target)) {
      if (event.repeat && (loading || grants.guard && (busy || recallCommand.test(editorText(input).trim()) ||
          editorText(input).startsWith(recallInstruction) || needsContext(editorText(input))))) {
        event.preventDefault(); event.stopImmediatePropagation(); return;
      }
      intercept(event,input);
    }
  },true);
  window.addEventListener('click', event => {
    if (event.defaultPrevented || dispatching || composing || !(event.target instanceof Element)) return;
    const link = event.target.closest<HTMLAnchorElement>('a[href]');
    if (link) {
      comparison = undefined; dismiss();
      if (grants.capture && event.isTrusted && !event.button && !event.ctrlKey && !event.metaKey && !event.shiftKey &&
          !event.altKey && (!link.target || link.target === '_self') && !link.hasAttribute('download') &&
          link.origin === location.origin) {
        const current = page(), next = chatRoute(service,link.pathname);
        if (current !== next) {
          captureRoute.beforeNavigation(next, transcriptFrames(service));
          // A cancelled same-tab click can return to the unchanged original thread.
          window.setTimeout(() => {
            if (active && grants.capture && page() === current) captureRoute.cancelNavigation(next,transcriptFrames(service));
          },1500);
        }
      }
    }
    const input = composer(service);
    const button = input && sendButton(service,input);
    if (input && button && button.contains(event.target)) intercept(event,input);
  },true);
  window.addEventListener('submit', event => {
    if (event.defaultPrevented || dispatching || composing) return;
    const input = composer(service);
    if (input && event.target === input.closest('form')) intercept(event,input);
  },true);
  window.addEventListener('input', event => {
    inputChanges++;
    const input = composer(service);
    if (!held || !input || !(event.target instanceof Node) || !input.contains(event.target) || page() !== held.route) return;
    if (editorText(input) !== held.question) {
      const current = held.route;
      const text = editorText(input);
      held = text ? {route: current, question:text} : undefined;
      save(current,text); hide();
    }
  },true);

  // Chrome fires navigate before a pushState/replaceState/traversal commits.
  const navigation = (window as Window & {navigation?:EventTarget}).navigation;
  navigation?.addEventListener('navigate', event => {
    const {destination,signal} = event as Event & {destination:{url:string}; signal:AbortSignal};
    if (!active || !grants.capture) return;
    const url = new URL(destination.url);
    if (url.origin !== location.origin) return;
    const current = page(), next = chatRoute(service,url.pathname);
    if (next === current) return;
    captureRoute.beforeNavigation(next,transcriptFrames(service));
    signal.addEventListener('abort',() => {
      if (active && grants.capture && page() === current) captureRoute.cancelNavigation(next,transcriptFrames(service));
    },{once:true});
  });
  navigation?.addEventListener('currententrychange',() => schedule());

  function syncRoute() {
    const next = page();
    if (next === route) return;
    captureRoute.change(next);
    const previous = route; route = next; epoch++; captured.clear(); held = undefined; savedDraft = undefined; hide();
    if (previous === 'new' && next && sent && sent.request.route === 'new' && !sent.delivered && grants.share) {
      // A URL change alone cannot identify the new conversation. Redisplay only
      // after the actual submitted user turn appears on the canonical route.
      sent.request.route = next; sent.moving = true;
      // Some sites render the user turn before assigning the canonical URL.
      if (!sent.receipt) track(sent,sent.request.question);
      if (sent.receipt) sent.receipt.previous = undefined;
    } else { sent = undefined; comparison = undefined; }
    if (!previous && next) refresh();
    else void restore(next);
  }
  function capture(): Promise<CaptureScan | false> {
    committing = committing.then(async () => {
      syncRoute();
      const current = route;
      const id = epoch;
      if (!active || !grants.capture || !current || current === 'new') return false;
      const receipt = {epoch:id,routeGeneration:captureRoute.generation,scan:false as CaptureScan | false};
      lastCapture = receipt;
      const snapshot = renderedTranscript(service);
      if (!captureRoute.permits(snapshot)) {
        receipt.scan = {observed:0,readable:0,routeUnverified:true};
        return receipt.scan;
      }
      const {ordered,observed} = snapshot;
      const occurrences = new Map<string,number>();
      let readable = 0;
      type PendingTurn = {id:string; role:'user'|'assistant'; text:string; cacheKey:string; hash:string};
      const pending: PendingTurn[] = [];
      let pendingUnits = 0;
      const routeGeneration = captureRoute.generation;
      const currentScan = () => active && grants.capture && epoch === id && page() === current && captureRoute.generation === routeGeneration;
      async function flush(): Promise<boolean> {
        if (!currentScan()) return false;
        if (!pending.length) return true;
        const turns = pending.map(({id,role,text}) => ({id,role,text}));
        const result = await ask<{ok:boolean}>({type:'captureBatch',conversationId:current,turns});
        if (!result?.ok || !currentScan()) return false;
        for (const entry of pending) captured.set(entry.cacheKey,entry.hash);
        pending.length = 0;
        pendingUnits = 0;
        return true;
      }
      for (const turn of ordered) {
        if (page() !== current || epoch !== id || !active) return false;
        if (turn.role === 'user' && turn.text.includes(marker)) continue;
        readable++;
        const digest = await crypto.subtle.digest('SHA-256',new TextEncoder().encode(turn.text));
        const hash = Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2,'0')).join('');
        let messageId = turn.id;
        if (!messageId) {
          // No provider ID. Scope identical visible bodies by role and occurrence;
          // these records have no authority to trigger manuscript or decision rules.
          const bucket = turn.role + ':' + hash;
          const occurrence = (occurrences.get(bucket) ?? 0) + 1;
          occurrences.set(bucket,occurrence);
          messageId = 'local:' + hash + ':' + occurrence;
        }
        const key = turn.role + ':' + messageId;
        if (page() !== current || epoch !== id || !active) return false;
        if (captured.get(key) === hash) continue;
        if (turn.id && turn.role === 'user' && sent && sent.request.route === current && turn.text === sent.request.question) {
          if (!await flush()) return false;
          if (!currentScan()) return false;
          const acknowledged = await ask<{ok:boolean}>({type:'bind',conversationId:current,projectId:sent.record.projectId});
          if (epoch !== id || page() !== current) return false;
          if (!acknowledged.ok) return false;
        }
        if ((pending.length >= maxCaptureBatchTurns || pendingUnits + turn.text.length > maxCaptureBatchUnits) && !await flush()) return false;
        pending.push({id:messageId,role:turn.role,text:turn.text,cacheKey:key,hash});
        pendingUnits += turn.text.length;
      }
      if (!await flush()) return false;
      receipt.scan = {observed,readable};
      return receipt.scan;
    }).catch(() => false as const);
    return committing;
  }
  function schedule() {
    syncRoute();
    applySavedDraft();
    if (sent) watchReceipt(sent);
    mount();
    if (!active || !grants.capture) return;
    if (scheduledScan) { changedDuringScan = true; return; }
    if (timer) return;
    timer = window.setTimeout(() => {
      timer = 0;
      scheduledScan = true;
      void capture().finally(() => {
        scheduledScan = false;
        if (changedDuringScan) { changedDuringScan = false; schedule(); }
      });
    },80);
  }
  const observer = new MutationObserver(records => {
    // Streaming can finish and stable message IDs can arrive without a new DOM node.
    // Ignore unrelated class changes such as pointer hover styles.
    const relevant = records.some(record =>
      record.attributeName !== 'class' || (record.target instanceof Element &&
        (record.target.classList.contains('result-streaming') || record.oldValue?.split(/\s+/).includes('result-streaming')))
    );
    if (relevant) schedule();
  });
  function observe() {
    observer.observe(document, {childList:true, subtree:true, characterData:true, attributes:true, attributeOldValue:true,
      attributeFilter:['data-message-id','data-message-author-role','data-turn','data-turn-id','data-testid','data-is-streaming','aria-busy','class']});
  }
  async function settings() {
    const run = ++generation;
    captureRoute.forgetSubmit();
    epoch++; sent = undefined; comparison = undefined; held = undefined; savedDraft = undefined; captured.clear(); hide(); grants = {capture:false,share:false,guard:false};
    const result = await ask<typeof grants>({type:'settings'}).catch(() => undefined);
    if (run !== generation || !active || !result) return;
    grants = {capture:result.capture === true, share:result.share === true,
      guard: result.guard === true || result.capture === true || result.share === true};
    await restore(page()); schedule();
  }
  function refresh() {
    const reading = settings();
    loading = reading;
    void reading.finally(() => { if (loading === reading) loading = undefined; });
  }
  chrome.runtime.onMessage.addListener((message, sender, respond) => {
    if (sender.id !== chrome.runtime.id) return;
    if (message?.type === 'settingsChanged') refresh();
    if (message?.type === 'captureHealth' && !sender.tab) {
      // Reading the popup must not force a scan or replay an approval.
      const conversationId = page();
      if (!active || message.conversationId !== conversationId || !conversationId || conversationId === 'new') { respond(unverified); return; }
      const receipt = lastCapture;
      if (loading || !grants.capture || route !== conversationId || !receipt || receipt.epoch !== epoch ||
          receipt.routeGeneration !== captureRoute.generation || scheduledScan || timer) {
        respond({conversationId,health:'pending'});
      } else if (!receipt.scan || receipt.scan.routeUnverified) {
        respond({conversationId,health:receipt.scan ? 'route-unverified' : 'unverified'});
      } else {
        respond({conversationId,observed:receipt.scan.observed,readable:receipt.scan.readable});
      }
      return;
    }
    if (message?.type === 'compareReply' && !sender.tab) {
      if (message.conversationId !== undefined && message.conversationId !== page()) { respond(unverified); return; }
      void compareReply().then(respond,() => respond(unverified));
      return true;
    }
    if (message?.type === 'flushCapture' && !sender.tab) {
      syncRoute();
      const current = route;
      if (loading || !active || !grants.capture || !current || current === 'new' ||
          (message.conversationId !== undefined && message.conversationId !== current)) {
        respond({ok:false}); return;
      }
      const id = epoch;
      void capture().then(scan => {
        if (!scan || !active || id !== epoch || !grants.capture || page() !== current) {
          respond({ok:false}); return;
        }
        if (scan.routeUnverified) { respond({ok:false,status:'route-unverified'}); return; }
        const recoveryTurns = service === 'chatgpt' && message.checkInitialApproval === true &&
          message.conversationId === current && captureRoute.permits(renderedTranscript(service)) ? initialCaptureTranscript() : undefined;
        respond({ok:true, conversationId:current, ...scan, recoveryTurns});
      });
      return true;
    }
  });
  window.addEventListener('popstate',() => { comparison = undefined; dismiss(); schedule(); });
  window.addEventListener('pagehide', () => {
    active = false; epoch++; observer.disconnect(); window.clearTimeout(timer); timer = 0; captured.clear(); sent = undefined; comparison = undefined; hide();
  });
  window.addEventListener('pageshow', event => {
    if (event.persisted) { active = true; observe(); refresh(); }
  });
  observe(); refresh();
}

if (location.hostname === 'chatgpt.com') start('chatgpt');
if (location.hostname === 'claude.ai') start('claude');

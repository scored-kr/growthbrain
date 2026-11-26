export type ChatService = 'chatgpt' | 'claude';
export type Editor = HTMLTextAreaElement | HTMLElement;
export interface RenderedTurn {
  id?: string;
  role: 'user' | 'assistant';
  text: string;
}

export interface VisibleTurn extends RenderedTurn { id: string }

// Limit access to the ordinary chat surface. Project pages, previews and other
// editors on the same origins must never receive the composer integration.
export function chatRoute(service: ChatService, pathname: string): string | undefined {
  if (pathname === '/' || (service === 'claude' && /^\/new\/?$/.test(pathname))) return 'new';
  const match = (service === 'chatgpt' ? /^\/c\/([\w.-]+)\/?$/ : /^\/chat\/([\w.-]+)\/?$/).exec(pathname);
  return match?.[1];
}

const sites = {
  chatgpt: {
    editor: '#prompt-textarea:is(textarea,[contenteditable="true"])',
    send: 'button[data-testid="send-button"],button#composer-submit-button[aria-label*="Send" i]',
    turns: '[data-message-author-role]',
    stop: 'button[data-testid="stop-button"]',
  },
  claude: {
    editor: '[data-testid="chat-input"][contenteditable="true"],.ProseMirror[contenteditable="true"]',
    send: 'button[data-testid="send-message"],button[aria-label="Send message" i],button[aria-label="메시지 보내기"]',
    turns: '[data-testid="user-message"],[data-testid="assistant-message"],.font-claude-response',
    stop: 'button[data-testid="stop-response"],button[aria-label="Stop response" i]',
  },
};

export function composer(service: ChatService): Editor | undefined {
  // More than one visible editor is ambiguous (e.g. editing an old message).
  const candidates = [...document.querySelectorAll<HTMLElement>(sites[service].editor)]
    .filter(el => el.getClientRects().length > 0 && !el.closest('[role="dialog"],growth-brain-notice'));
  return candidates.length === 1 ? candidates[0] : undefined;
}

export function sendButton(service: ChatService, editor: Editor): HTMLButtonElement | undefined {
  const form = editor.closest('form');
  const scope = form ?? document;
  const buttons = [...scope.querySelectorAll<HTMLButtonElement>(sites[service].send)]
    .filter(b => b.getClientRects().length > 0 && !b.closest('[role="dialog"]'));
  return buttons.length === 1 ? buttons[0] : undefined;
}

export function editorText(editor: Editor): string {
  if (editor instanceof HTMLTextAreaElement) return editor.value;
  // Chromium and ProseMirror keep one BR in a visually empty editor.
  const sole = editor.firstElementChild;
  if (!editor.textContent && editor.children.length === 1 && (sole?.tagName === 'BR' ||
      sole?.tagName === 'P' && sole.children.length === 1 && sole.firstElementChild?.tagName === 'BR')) return '';
  return editor.innerText.replace(/\r\n/g, '\n');
}

export function setEditorText(editor: Editor, text: string): boolean {
  editor.focus();
  if (editor instanceof HTMLTextAreaElement) {
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(editor, text);
    editor.dispatchEvent(new InputEvent('input', {bubbles: true, inputType: 'insertText', data: text}));
  } else {
    // Update the editing transaction (ProseMirror), including paragraphs, so
    // the native send control sees the same value as the user.
    const range = document.createRange();
    range.selectNodeContents(editor);
    const selection = window.getSelection();
    if (!selection) return false;
    selection.removeAllRanges();
    selection.addRange(range);
    // A single insertText command wraps empty lines in <div><br></div>,
    // adding a newline when Chromium serializes the user's message.
    if (!text) document.execCommand('delete');
    for (const [index,line] of text.split('\n').entries()) {
      if (index && !document.execCommand('insertLineBreak')) return false;
      if (line && !document.execCommand('insertText', false, line)) return false;
    }
  }
  return editorText(editor) === text;
}

export function noticeAnchor(editor: Editor): Element {
  return editor.closest('form') ?? editor.closest('[data-testid="chat-input-container"], [data-type="unified-composer"]') ?? editor;
}

const contentSelector = '[data-message-content],.markdown,.standard-markdown,.whitespace-pre-wrap';
function turnContent(node: HTMLElement): HTMLElement {
  return node.querySelector<HTMLElement>(contentSelector) ?? node;
}

// Inspect only the last rendered user turn for our own outstanding submission.
// This acknowledgement works when the user permits sharing but disables capture.
export function lastUserNode(service: ChatService): HTMLElement | undefined {
  const surface = conversationSurface(service);
  if (!surface) return;
  for (const marks of [...groupedTurns(surface, service).values()].reverse()) {
    if (!marks.some(mark => explicitRole(mark, service) === 'user')) continue;
    const author = uniqueAuthor(marks, service);
    return author && readBody(author);
  }
}

function assistantText(content: HTMLElement): string {
  if (!content.querySelector('pre')) return content.innerText;
  // Recover the explicit manuscript boundaries that Markdown renderers hide.
  // Never pull a code block's copy button, language menu or toolbar into copy.
  const blocks: string[] = [];
  for (const child of content.childNodes) {
    if (child.nodeType === Node.TEXT_NODE) {
      if (child.textContent?.trim()) blocks.push(child.textContent);
      continue;
    }
    if (!(child instanceof HTMLElement)) continue;
    const pre = child.matches('pre') ? child : child.querySelector('pre');
    if (!pre) {
      if (!child.matches('button,[role="button"]') && !child.querySelector('button,[role="button"]')) blocks.push(child.innerText);
      continue;
    }
    const code = pre.querySelector('code');
    if (!code || child.querySelectorAll('pre').length > 1 || /^(?:`{3})/m.test(code.textContent ?? '')) return '';
    if (child !== pre && child.innerText.trim() !== pre.innerText.trim()) return '';
    const body = code.textContent ?? '';
    blocks.push('```text\n' + body + (body.endsWith('\n') ? '' : '\n') + '```');
  }
  return blocks.join('\n');
}

function turnNodes(service: ChatService): HTMLElement[] {
  const selector = sites[service].turns;
  return [...document.querySelectorAll<HTMLElement>(selector)].filter(node => !node.parentElement?.closest(selector));
}

function turnId(node: HTMLElement): string | undefined {
  const id = node.closest('[data-message-id]')?.getAttribute('data-message-id') ??
    node.closest('[data-testid^="conversation-turn-"]')?.getAttribute('data-testid');
  return id && id.length <= 160 ? id : undefined;
}

function renderedChatBody(node: HTMLElement): boolean {
  return node.checkVisibility({checkOpacity:true, checkVisibilityCSS:true}) && node.getClientRects().length > 0 &&
    !node.closest('[hidden],[inert],[aria-hidden="true"],[role="dialog"]');
}

function turnRole(service: ChatService, node: HTMLElement) {
  if (service === 'claude') return node.dataset.testid === 'user-message' ? 'user' : 'assistant';
  return node.getAttribute('data-message-author-role');
}

function streaming(service: ChatService, node: HTMLElement, current = true): boolean {
  const busy = '[aria-busy="true"],[data-is-streaming="true"],.result-streaming';
  return !!((current && document.querySelector(sites[service].stop)) || node.closest(busy) || node.querySelector(busy));
}

// A baseline contains only the visible turn identities at dispatch. A changed
// branch, virtualized history or ambiguous DOM cannot establish adjacency.
function visibleClaudeNodes() {
  return turnNodes('claude').filter(node => node.getClientRects().length && !node.closest('[aria-hidden="true"],[inert]'));
}
function claudeKey(node: HTMLElement): string | undefined {
  const id = turnId(node);
  return id && turnRole('claude',node) + ':' + id;
}
export function claudeTurnBaseline(): string[] | undefined {
  const keys = new Set<string>();
  for (const node of visibleClaudeNodes()) {
    const key = claudeKey(node);
    if (!key || keys.has(key)) return;
    keys.add(key);
  }
  return [...keys];
}

export function claudeUserId(content: HTMLElement): string | undefined {
  const node = content.closest<HTMLElement>('[data-testid="user-message"]');
  return node ? turnId(node) : undefined;
}

function hasCompletionEvidence(assistant: HTMLElement): boolean {
  const holder = assistant.closest<HTMLElement>('[data-message-id]') ?? assistant;
  const done = '[data-is-streaming="false"]';
  if (assistant.matches(done) || holder.matches(done)) return true;
  // Code-block copy controls and global chat controls say nothing about the
  // generation state. Only accept an action explicitly tied to this response.
  const content = turnContent(assistant);
  const selector = 'button[data-testid="action-bar-copy"],button[aria-label="Copy response" i],button[aria-label="응답 복사"],button[aria-label="답변 복사"]';
  return [...holder.querySelectorAll<HTMLButtonElement>(selector)].some(button =>
    !button.disabled && button.getAttribute('aria-disabled') !== 'true' && !button.closest('pre,code,[hidden],[aria-hidden="true"]') &&
    button.getClientRects().length > 0 && !content.contains(button));
}

export function completedClaudeReply(baseline: string[], userId: string, expected: string) {
  const nodes = visibleClaudeNodes();
  if (nodes.length !== baseline.length + 2 || baseline.some((key,i) => claudeKey(nodes[i]!) !== key)) return;
  const user = nodes[baseline.length]!, assistant = nodes[baseline.length+1]!;
  const key = 'user:' + userId;
  const assistantId = turnId(assistant);
  if (claudeKey(user) !== key || baseline.includes(key) || turnContent(user).innerText !== expected ||
      !assistantId || turnRole('claude',assistant) !== 'assistant' ||
      baseline.includes('assistant:' + assistantId) || streaming('claude',assistant) || !hasCompletionEvidence(assistant)) return;
  // Multiple text parts (for example separate tool results) cannot establish
  // that a single rendered manuscript is the entire reply.
  const selector = '[data-message-content],.standard-markdown,.markdown';
  const parts = [...assistant.querySelectorAll<HTMLElement>(selector)];
  if (parts.filter(part => !parts.some(other => other !== part && other.contains(part))).length > 1) return;
  const text = assistantText(turnContent(assistant));
  return text.trim() && text.length <= 64_000 ? {id:assistantId,text} : undefined;
}

// A rendered role or position is not an identity that can approve a remote read.
const turnBoundary = 'article,[data-testid^="conversation-turn-"]';
const identitySelector = '[data-message-id],[data-message-uuid],[data-turn-id]';
const authorMarker = '[data-message-author-role],[data-author-role],[data-turn],[data-role="user"],[data-role="assistant"],' +
  '[data-testid="user-message"],[data-testid="assistant-message"],[data-testid="conversation-turn-user"],[data-testid="conversation-turn-assistant"]';
const excluded = 'aside,nav,header,footer,form,[role="navigation"],[role="complementary"],[role="dialog"],[role="menu"],' +
  '[contenteditable="true"],[hidden],[inert],[aria-hidden="true"],.sr-only,details,[data-message-author-role="tool"],[data-role="tool"],' +
  '[data-turn="tool"],[data-author-role="tool"],[data-message-author-role="system"],[data-testid^="tool" i],[data-testid*="-tool" i],' +
  '[data-testid*="thinking" i],[data-testid*="reasoning" i],[data-type="thinking"],[data-testid*="artifact" i]';
const controls = 'button,[role="button"],[role="toolbar"],.toolbar,[data-testid*="copy" i],[data-testid*="action-bar" i]';
const captureContent = contentSelector + ',[data-testid="message-content"],.user-message-bubble-color,.whitespace-pre-line';
type Role = RenderedTurn['role'];
type ChatIsland = {frame: HTMLElement; author?: HTMLElement; body?: HTMLElement; role?: Role; id?: string; text?: string};

function conversationSurface(service: ChatService): HTMLElement | undefined {
  const cues = authorMarker + ',[data-testid^="conversation-turn-"]' + (service === 'claude' ? ',.font-claude-response' : '');
  for (const selector of ['main,[role="main"]', '[data-testid="conversation-panel"],[data-testid="conversation"],[data-testid="chat-messages"],[role="log"]']) {
    const surfaces = [...document.querySelectorAll<HTMLElement>(selector)].filter(el => renderedChatBody(el) && !el.closest(excluded));
    if (!surfaces.length) continue;
    if (surfaces.length === 1) return surfaces[0];
    const marked = [...document.querySelectorAll<HTMLElement>(cues)].filter(el => renderedChatBody(el) && !el.closest(excluded) && surfaces.some(surface => surface.contains(el)));
    const eligible = surfaces.filter(surface => marked.some(el => surface.contains(el)));
    const deepest = eligible.find(surface => eligible.every(other => other.contains(surface)));
    return deepest && marked.every(el => deepest.contains(el)) ? deepest : undefined;
  }
  // Some normal chats have no main landmark. Select only a shared thread
  // container of visible service-labelled turns, never the whole document.
  const selector = service === 'chatgpt' ? '[data-testid^="conversation-turn-"],[data-message-author-role]' :
    '[data-testid="user-message"],[data-testid="assistant-message"],.font-claude-response';
  const marked = [...document.querySelectorAll<HTMLElement>(selector)].filter(el => renderedChatBody(el) && !el.closest(excluded));
  if (marked.length < 2) return;
  const first = marked[0]!;
  for (let parent = first.parentElement; parent && parent !== document.body; parent = parent.parentElement) {
    if (marked.every(el => parent!.contains(el)) && !parent.matches(selector)) return parent;
  }
}

function explicitRole(node: HTMLElement, service: ChatService): Role | undefined {
  const names = [node.dataset.messageAuthorRole, node.dataset.authorRole, node.dataset.turn, node.dataset.role];
  const test = node.dataset.testid?.match(/^(?:conversation-turn-(user|assistant)|(user|assistant)-message)$/u);
  if (test) names.push(test[1] ?? test[2]);
  if (service === 'claude' && node.matches('.font-claude-response')) names.push('assistant');
  const labels = new Set(names.filter(Boolean));
  if (labels.size !== 1) return;
  if (labels.has('user')) return 'user';
  if (labels.has('assistant')) return 'assistant';
}

function bodyParts(author: HTMLElement): HTMLElement[] {
  const marked = [author, ...author.querySelectorAll<HTMLElement>(captureContent)]
    .filter(el => el.matches(captureContent) && renderedChatBody(el) && !el.closest(excluded));
  const selected = new Set(marked);
  return marked.filter(el => {
    for (let parent = el.parentElement; parent && author.contains(parent); parent = parent.parentElement) {
      if (selected.has(parent)) return false;
    }
    return true;
  });
}

function readBody(author: HTMLElement): HTMLElement | undefined {
  const outer = bodyParts(author);
  if (outer.length > 1) return;
  let body = outer[0] ?? author;
  if (!outer.length) {
    // Plain paragraphs can sit inside an identified message with the speaker
    // only on its outer wrapper. A sole-child chain preserves that association.
    let current = author;
    while (current.childElementCount === 1 && ![...current.childNodes].some(node => node.nodeType === Node.TEXT_NODE && node.nodeValue?.trim())) {
      const child = current.firstElementChild;
      if (!(child instanceof HTMLElement) || !renderedChatBody(child) || child.closest(excluded)) break;
      if (child.matches(identitySelector)) body = child;
      current = child;
    }
  }
  if (body.querySelector(excluded + ',' + controls)) return;
  // Chromium's innerText can include text under opacity:0. Render it only
  // through the local filtered walk when any descendant is not visibly painted.
  if ([...body.querySelectorAll<HTMLElement>('*')].some(el => el.childNodes.length && !el.checkVisibility({checkOpacity:true,checkVisibilityCSS:true}))) return;
  // Without a canonical text element, accept only plain rendered paragraphs.
  if (!outer.length && [...body.querySelectorAll('*')].some(el => !el.matches('div,span,p,br,strong,b,em,i,ul,ol,li,pre,code'))) return;
  return body;
}

// A local transcript can retain explicitly authored rich text whose structure is
// insufficient to approve a manuscript. Never read the entire turn container or
// serialize a cloned subtree: walk only supported visible text nodes.
function localBodyText(author: HTMLElement): string | undefined {
  const parts = bodyParts(author);
  const roots = parts.length ? parts : [author];
  const chunks: string[] = [];
  let length = 0;
  const newline = () => { if (chunks.length && !chunks.at(-1)!.endsWith('\n')) chunks.push('\n'); };
  function visit(node: Node) {
    if (length > 64_000) return;
    if (node.nodeType === Node.TEXT_NODE) {
      const value = node.nodeValue ?? '';
      length += value.length;
      chunks.push(value);
      return;
    }
    if (!(node instanceof HTMLElement) || node.matches(excluded + ',' + controls) ||
        !node.matches('article,section,div,p,span,b,strong,em,i,small,br,ul,ol,li,pre,code,blockquote,a,h1,h2,h3,h4,h5,h6,table,thead,tbody,tr,th,td,hr,mark,s,u,sub,sup') ||
        !renderedChatBody(node)) return;
    if (node.tagName === 'BR') { newline(); return; }
    const block = /^(block|list-item|table.*|flex|grid|flow-root)$/.test(getComputedStyle(node).display);
    if (block) newline();
    for (const child of node.childNodes) visit(child);
    if (block) newline();
  }
  for (const root of roots) { newline(); visit(root); }
  const text = chunks.join('').trim();
  return text && text.length <= 64_000 && length <= 64_000 ? text : undefined;
}

function explicitMessageId(frame: HTMLElement, body: HTMLElement): string | undefined {
  // Use only IDs along the actual body-to-frame chain; sibling controls and
  // quoted IDs inside a user's text don't identify the surrounding turn.
  const messageIds = new Set<string>(), turnIds = new Set<string>();
  for (let el: HTMLElement | null = body; el; el = el.parentElement) {
    if (el.dataset.messageId) messageIds.add(el.dataset.messageId);
    if (el.dataset.messageUuid) messageIds.add(el.dataset.messageUuid);
    if (el.dataset.turnId) turnIds.add(el.dataset.turnId);
    if (el === frame) break;
  }
  if (messageIds.size > 1 || turnIds.size > 1) return;
  const id = [...messageIds][0] ?? [...turnIds][0];
  return id && id.length <= 160 && !/^(?:local:|(?:conversation-turn-)?[0-9]+$)/iu.test(id) ? id : undefined;
}

function groupedTurns(surface: HTMLElement, service: ChatService): Map<HTMLElement, HTMLElement[]> {
  const selector = service === 'claude' ? authorMarker + ',.font-claude-response' : authorMarker;
  const groups = new Map<HTMLElement, HTMLElement[]>();
  const candidates = surface.querySelectorAll<HTMLElement>(selector + ',[data-testid^="conversation-turn-"]');
  for (const node of candidates) {
    if (!renderedChatBody(node) || node.closest(excluded)) continue;
    let outer = node;
    for (let parent = node.parentElement; parent && parent !== surface; parent = parent.parentElement) {
      if (parent.matches(turnBoundary)) break;
      if (parent.matches(selector)) outer = parent;
    }
    const boundary = outer.closest<HTMLElement>(turnBoundary);
    const holder = outer.closest<HTMLElement>(identitySelector);
    const frame = boundary && surface.contains(boundary) ? boundary :
      holder && holder !== surface && surface.contains(holder) ? holder : outer;
    const marks = groups.get(frame) ?? [];
    if (node.matches(selector)) marks.push(node);
    groups.set(frame, marks);
  }
  return groups;
}

function uniqueAuthor(marks: HTMLElement[], service: ChatService): HTMLElement | undefined {
  // A repeated label in one wrapper chain is a single speaker. Siblings or
  // contradictory labels can denote distinct messages or alternative branches.
  const author = marks.at(-1);
  const role = author && explicitRole(author, service);
  return role && marks.every(el => el.contains(author!) && explicitRole(el, service) === role) ? author : undefined;
}

function captureIslands(surface: HTMLElement, service: ChatService): ChatIsland[] {
  const groups = groupedTurns(surface, service);
  const latest = [...groups.keys()].at(-1);
  const islands: ChatIsland[] = [];
  for (const [frame, marks] of groups) {
    const island: ChatIsland = {frame};
    islands.push(island);
    let author = uniqueAuthor(marks, service);
    const unambiguous = Boolean(author);
    if (!author && service === 'claude' && marks[0]?.matches('[data-testid="assistant-message"]') &&
        marks.slice(1).every(mark => marks[0]!.contains(mark) && mark.matches('.font-claude-response') && explicitRole(mark, service) === 'assistant')) {
      author = marks[0];
    }
    const role = author && explicitRole(author, service);
    if (!role || !author || (role === 'assistant' && streaming(service, frame, frame === latest))) continue;
    const body = unambiguous ? readBody(author) : undefined;
    const exact = body && (role === 'assistant' ? assistantText(body) : body.innerText);
    const text = exact || localBodyText(author);
    if (!text?.trim() || text.length > 64_000) continue;
    const multipleRoles = frame.querySelector('[data-message-author-role="tool"],[data-message-author-role="system"],[data-role="tool"]');
    Object.assign(island, {role, author, body, text, id:!multipleRoles && exact && body ? explicitMessageId(frame, body) : undefined});
  }
  return islands;
}

function orderedTranscript(islands: ChatIsland[]): RenderedTurn[] {
  const ids = new Set<string>(), duplicates = new Set<string>();
  for (const {id} of islands) {
    if (id && ids.has(id)) duplicates.add(id);
    if (id) ids.add(id);
  }
  const ordered: RenderedTurn[] = [];
  let reliable = true;
  for (const {role, text, id} of islands) {
    // An unreadable newer reply could contain different drafts. Never apply a
    // subsequent approval to the older drafts by silently skipping over it.
    if (!id || duplicates.has(id)) reliable = false;
    if (role && text) ordered.push(reliable && id ? {id, role, text} : {role, text});
  }
  return ordered;
}

// DOM handles stay in the content script to distinguish an unchanged source
// subtree during same-document navigation. This read does not inspect text.
export function transcriptFrames(service: ChatService): HTMLElement[] {
  const surface = conversationSurface(service);
  return surface ? [...groupedTurns(surface, service).keys()] : [];
}

export function renderedTranscript(service: ChatService): {ordered: RenderedTurn[]; observed: number; frames: HTMLElement[]; surface?: HTMLElement} {
  const surface = conversationSurface(service);
  const islands = surface ? captureIslands(surface, service) : [];
  return {ordered:orderedTranscript(islands), observed:islands.length, frames:islands.map(island => island.frame), surface};
}

export function visibleTurns(service: ChatService): VisibleTurn[] {
  return renderedTranscript(service).ordered.filter((turn): turn is VisibleTurn => turn.id !== undefined);
}

export function initialCaptureTranscript(): VisibleTurn[] | undefined {
  const surface = conversationSurface('chatgpt');
  if (!surface) return;
  const islands = captureIslands(surface, 'chatgpt');
  if (islands.length !== 3 && islands.length !== 4) return;
  const turns = orderedTranscript(islands);
  if (turns.length !== islands.length || !turns.every((turn): turn is VisibleTurn => turn.id !== undefined)) return;
  const frames = islands.map(island => island.frame);
  const siblings = frames[0]?.parentElement?.children;
  if (siblings?.length !== frames.length || frames.some((frame, i) => siblings[i] !== frame)) return;
  const marked = surface.querySelectorAll(turnBoundary + ',' + identitySelector);
  if ([...marked].some(mark => !frames.some(frame => frame.contains(mark)))) return;
  for (const [i, island] of islands.entries()) {
    if (island.role !== (i % 2 === 0 ? 'user' : 'assistant') || !island.body || !island.author ||
        !island.body.matches(captureContent) || streaming('chatgpt', island.frame)) return;
    if ([...island.frame.querySelectorAll(captureContent)].some(part => !island.body!.contains(part) && !part.contains(island.body!))) return;
    if (i === 3 && island.frame.dataset.isStreaming !== 'false' && !hasCompletionEvidence(island.author)) return;
  }
  return turns;
}

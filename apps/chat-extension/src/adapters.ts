export type ChatService = 'chatgpt' | 'claude';
export type Editor = HTMLTextAreaElement | HTMLElement;
export interface VisibleTurn {
  id: string;
  role: 'user' | 'assistant';
  text: string;
}

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
    turns: '[data-message-author-role][data-message-id]',
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

function turnContent(node: HTMLElement): HTMLElement {
  return node.querySelector<HTMLElement>('[data-message-content],.markdown,.standard-markdown,.whitespace-pre-wrap') ?? node;
}

// Inspect only the last rendered user turn for our own outstanding submission.
// This acknowledgement works when the user permits sharing but disables capture.
export function lastUserNode(service: ChatService): HTMLElement | undefined {
  const selector = service === 'chatgpt' ? '[data-message-author-role="user"]' : '[data-testid="user-message"]';
  const nodes = document.querySelectorAll<HTMLElement>(selector);
  return nodes.length ? turnContent(nodes[nodes.length-1]!) : undefined;
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

function turnRole(service: ChatService, node: HTMLElement) {
  if (service === 'claude') return node.dataset.testid === 'user-message' ? 'user' : 'assistant';
  return node.getAttribute('data-message-author-role');
}

function streaming(service: ChatService, node: HTMLElement): boolean {
  const busy = '[aria-busy="true"],[data-is-streaming="true"],.result-streaming';
  return !!(document.querySelector(sites[service].stop) || node.closest(busy) || node.querySelector(busy));
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

export function visibleTurns(service: ChatService): VisibleTurn[] {
  const output: VisibleTurn[] = [];
  const nodes = turnNodes(service);
  for (const node of nodes) {
    const id = turnId(node);
    const role = turnRole(service,node);
    if (!id || (role !== 'user' && role !== 'assistant')) continue;
    if (role === 'assistant' && node === nodes.at(-1) && streaming(service,node)) continue;
    const content = turnContent(node);
    const text = role === 'assistant' ? assistantText(content) : content.innerText;
    if (text?.trim() && text.length <= 64_000) output.push({id,role,text});
  }
  return output;
}

export type NoticeAction = {label: string; run(): void; primary?: boolean};
export interface NoticeView {
  label: string;
  body?: string;
  preview?: string;
  actions?: NoticeAction[];
  expanded?: boolean;
  toggle?: () => void;
  close: () => void;
}

export class ComposerNotice {
  private readonly host = document.createElement('growth-brain-notice');
  // Keep the preview out of the chat page's normal text collection and styles.
  private readonly root = this.host.attachShadow({mode: 'closed'});
  private readonly box = document.createElement('section');

  constructor() {
    const style = document.createElement('style');
    style.textContent = `
      :host{display:block;width:100%;box-sizing:border-box;margin:0 0 6px;font:400 14px/1.5 Nexon,system-ui,sans-serif;color:#111827;text-align:start;color-scheme:light}
      *{box-sizing:border-box}section{background:#f5f9ff;border:1px solid #dce3ee;border-radius:12px;overflow:hidden}header{display:flex;align-items:center;justify-content:space-between;min-height:32px;padding:0 6px 0 12px;color:#0052cc}
      button{font:inherit;cursor:pointer;color:#0052cc;background:transparent;border:0;border-radius:8px;padding:5px 8px}button:focus-visible{outline:2px solid #0062f5;outline-offset:-2px}header button:first-child{padding-left:0;text-align:left;font-weight:600}.close{font-size:18px}
      article{border-top:1px solid #dce3ee;padding:10px 12px;background:white}p{margin:0 0 8px}pre{max-height:14em;overflow:auto;white-space:pre-wrap;overflow-wrap:anywhere;background:#eef5ff;padding:10px 12px;border-radius:12px;font:inherit;margin:0 0 8px}footer{display:flex;flex-wrap:wrap;gap:6px}footer button{background:#eef5ff;border-radius:12px}button.primary{background:#0062f5;color:white;font-weight:600}
    `;
    this.box.setAttribute('aria-label', 'Growth Brain');
    this.root.append(style, this.box);
  }

  mount(anchor: Element): void {
    if (this.host.nextElementSibling !== anchor || !this.host.isConnected) anchor.before(this.host);
  }

  close(): void { this.host.remove(); this.box.replaceChildren(); }

  render(view: NoticeView): void {
    const header = document.createElement('header');
    if (view.toggle) {
      const disclosure = this.button(view.label, view.toggle);
      disclosure.setAttribute('aria-expanded', String(!!view.expanded));
      header.append(disclosure);
    } else {
      const label = document.createElement('span');
      label.setAttribute('role', 'status');
      label.textContent = view.label;
      header.append(label);
    }
    const close = this.button('×', view.close);
    close.className = 'close';
    close.setAttribute('aria-label', '알림 닫기');
    header.append(close);
    this.box.replaceChildren(header);
    if (!view.preview && !view.body && !view.actions?.length) return;
    const article = document.createElement('article');
    if (view.body) {
      const body = document.createElement('p');
      body.textContent = view.body;
      article.append(body);
    }
    if (view.preview) {
      const preview = document.createElement('pre');
      preview.textContent = view.preview;
      article.append(preview);
    }
    if (view.actions?.length) {
      const footer = document.createElement('footer');
      for (const action of view.actions) {
        const button = this.button(action.label, action.run);
        if (action.primary) button.className = 'primary';
        footer.append(button);
      }
      article.append(footer);
    }
    this.box.append(article);
  }

  private button(text: string, action: () => void): HTMLButtonElement {
    const button = document.createElement('button');
    button.type = 'button';
    button.textContent = text;
    button.addEventListener('click', event => {
      if (event.isTrusted) action();
    });
    return button;
  }
}

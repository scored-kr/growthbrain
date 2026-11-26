// A same-document navigation updates the URL independently of the chat renderer.
// Keep only DOM weak references and provider IDs as ownership evidence.
import type { RenderedTurn } from './adapters.ts'

type Transcript = {frames:HTMLElement[]; surface?:HTMLElement; ordered:RenderedTurn[]}
type Departure = {next:string | undefined; frames:WeakRef<HTMLElement>[]; complete:boolean; emptyNew:boolean}
const ownerSelector = '[data-conversation-id],[data-chat-id]'

export class CaptureRouteGuard {
  private route: string | undefined
  private documentTrusted: boolean
  private initialNew: boolean
  private firstText?: string
  private lastFrames: WeakRef<HTMLElement>[] = []
  private lastComplete = false
  private pending?: Departure
  private departure?: Departure
  private replaced = false
  private frames = new WeakMap<HTMLElement,string>()
  private ids = new Map<string,string>()
  private containers = new WeakMap<Element,string>()
  private identitiesFull = false
  generation = 0

  constructor(route: string | undefined) {
    this.route = route
    this.documentTrusted = Boolean(route && route !== 'new')
    this.initialNew = route === 'new'
  }

  firstSubmit(text: string, frames: HTMLElement[]) {
    if (this.route === 'new' && this.initialNew && !frames.length && text.trim() && text.length <= 64_000) this.firstText = text
  }

  beforeNavigation(next: string | undefined, frames: HTMLElement[]) {
    if (this.route === next || this.pending && this.pending.next === next) return
    this.generation++
    const previousFrames = this.lastFrames
    const complete = this.lastComplete && previousFrames.length === frames.length &&
      frames.every((frame,i) => previousFrames[i]?.deref() === frame)
    this.pending = {next, frames:previousFrames, complete, emptyNew:this.initialNew && this.route === 'new' && !frames.length}
  }

  cancelNavigation(next: string | undefined, frames: HTMLElement[]) {
    const before = this.pending
    if (!before || before.next !== next || frames.length !== before.frames.length ||
        !frames.every((frame,i) => before.frames[i]?.deref() === frame)) return
    this.pending = undefined
    this.generation++
  }

  change(next: string | undefined) {
    if (this.route === next) return
    this.generation++
    this.departure = this.pending?.next === next ? this.pending : undefined
    this.pending = undefined
    if (this.route !== 'new' || !this.initialNew) this.firstText = undefined
    this.initialNew = false
    this.documentTrusted = false
    this.replaced = false
    this.lastComplete = false
    this.lastFrames = []
    this.route = next
  }

  permits({frames, surface, ordered}: Transcript): boolean {
    const route = this.route
    if (!route || route === 'new' || this.pending) return false
    const knownElsewhere = (owner?:string) => Boolean(owner && owner !== route)
    if (frames.some(frame => knownElsewhere(this.frames.get(frame))) ||
        ordered.some(turn => turn.id && knownElsewhere(this.ids.get(turn.id)))) return false

    let everyFrameLabelled = frames.length > 0
    for (const frame of frames) {
      let labelled = false
      for (let owner = frame.closest<HTMLElement>(ownerSelector); owner && surface?.contains(owner);
           owner = owner.parentElement?.closest<HTMLElement>(ownerSelector) ?? null) {
        if (knownElsewhere(owner.dataset.conversationId) || knownElsewhere(owner.dataset.chatId) ||
            knownElsewhere(this.containers.get(owner)) || !(owner.dataset.conversationId || owner.dataset.chatId)) return false
        labelled = true
      }
      if (!labelled) everyFrameLabelled = false
    }
    const complete = frames.length > 0 && frames.length === ordered.length && ordered.every(turn => turn.id)
    // A renderer can replace its entire message list before changing the URL.
    // Without one continuing frame, provider ID or explicit chat label we
    // cannot assign that new list to the old URL, even on the original page.
    if (frames.length && this.lastFrames.length && !everyFrameLabelled &&
        !frames.some(frame => this.frames.get(frame) === route) &&
        !ordered.some(turn => turn.id && this.ids.get(turn.id) === route)) return false
    // An empty new-chat editor can render its first user message either side
    // of canonicalization. The next page must show that exact submitted turn.
    if (this.firstText && ordered[0]?.role === 'user' && ordered[0].text === this.firstText &&
        ordered.length === frames.length) {
      this.documentTrusted = true
      this.firstText = undefined
    }
    if (!this.documentTrusted && !everyFrameLabelled) {
      if (!complete || this.identitiesFull) return false
      if (!this.replaced) {
        const before = this.departure
        if (!before || !(before.emptyNew || before.complete && before.frames.every(ref => !ref.deref()?.isConnected))) return false
        this.replaced = true
      }
    }
    for (const frame of frames) {
      this.frames.set(frame, route)
      for (let node: HTMLElement | null = frame; node; node = node.parentElement) {
        if (!this.containers.has(node)) this.containers.set(node, route)
        if (node === surface) break
      }
    }
    for (const {id} of ordered) {
      if (!id || this.ids.has(id)) continue
      if (this.ids.size >= 20_000) { this.identitiesFull = true; break }
      this.ids.set(id, route)
    }
    if (frames.length) {
      this.lastFrames = frames.map(frame => new WeakRef(frame))
      this.lastComplete = complete
    }
    return true
  }

  // Release the text temporarily held for a consented submit upon settings
  // changes. Keep route provenance so toggling consent can't authorize stale DOM.
  forgetSubmit() { this.firstText = undefined }
}

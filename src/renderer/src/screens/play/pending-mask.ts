// The Channels strip's optimistic voice mask: a click shows at once, and main's answer to the
// latest request settles it. Whatever main made of it: a mask it clamped, or one it left as it
// was, doesn't change the player state, so waiting for a state change could show a mute forever.
export class PendingMask {
  /** What the pills show until the latest request is answered; null: the player state's mask. */
  mask: bigint | null = null
  private ticket = 0

  /** A request for `mask` goes out: show it. Returns the ticket to answer it with. */
  send(mask: bigint): number {
    this.mask = mask
    return ++this.ticket
  }

  /**
   * Request `ticket` was answered (or failed): when it's the latest, the player state (already
   * updated: main broadcasts before it answers) is the truth again. True if that changed anything.
   */
  answered(ticket: number): boolean {
    if (ticket !== this.ticket || this.mask === null) return false
    this.mask = null
    return true
  }

  /** Another track: its voices start from the player state, and answers still on their way are stale. */
  reset(): boolean {
    this.ticket++
    if (this.mask === null) return false
    this.mask = null
    return true
  }
}

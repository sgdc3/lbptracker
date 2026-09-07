/**
 * Whether a scrolling view should keep the playhead in sight.
 *
 * The board and the roll scroll to follow the playhead while the song plays,
 * and that used to win over the person: scroll ahead to look at the next
 * bars, or back to an earlier one, and the next tick dragged the view back to
 * the playhead. So the follow is a state, not a rule: a scroll by the person
 * that leaves the playhead out of view switches it off, a scroll that brings
 * the playhead back into view switches it on, and a seek or a play from the
 * transport switches it on too.
 *
 * ❗ **Checked against the position, not the event.** A scroll event is
 * delivered on the next frame, and the scheduler's tick landed 1 ms after the
 * person's scroll and before that event, saw the follow still on and pulled
 * the view straight back (measured). So the view remembers the position it
 * last knew, and any difference at the moment of following is the person's.
 */
export class Follow {
  private following = true;
  private knownLeft: number;

  private readonly scroller: HTMLElement;
  /** Whether the playhead is in the view as it is scrolled now; true when there is none. */
  private readonly playheadInView: () => boolean;

  constructor(scroller: HTMLElement, playheadInView: () => boolean) {
    this.scroller = scroller;
    this.playheadInView = playheadInView;
    this.knownLeft = scroller.scrollLeft;
    scroller.addEventListener('scroll', () => this.notice());
  }

  /** A change of position since the view last looked is the person's: follow or not by where the playhead is now. */
  private notice(): void {
    if (this.scroller.scrollLeft === this.knownLeft) return;
    this.knownLeft = this.scroller.scrollLeft;
    this.following = this.playheadInView();
  }

  /** Whether to follow right now, the person's scrolls taken into account. */
  get on(): boolean {
    this.notice();
    return this.following;
  }

  /** The view's own scroll, to keep the playhead in sight. */
  scrollTo(left: number): void {
    this.scroller.scrollLeft = left;
    this.knownLeft = this.scroller.scrollLeft;
  }

  /** A seek, or play pressed: back to following, wherever the view was left. */
  resume(): void {
    this.knownLeft = this.scroller.scrollLeft;
    this.following = true;
  }
}

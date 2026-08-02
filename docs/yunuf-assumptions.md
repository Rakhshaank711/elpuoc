# Yunuf implementation assumptions

- The draw source is the previous active discard combination. A player first places their new discard, then draws from the preserved previous combination or the face-down deck.
- The first hand starts with a server-random active player. Later hands rotate the starting player clockwise among non-eliminated seats.
- The host advances from hand results and may reset a completed match to the same lobby. This avoids clients racing to deal.
- Players keep their seats while disconnected. Their turn is auto-played when its authoritative timer expires; browser heartbeats handle active rooms and the authenticated cron endpoint handles fully unattended rooms.
- The reconnect grace period does not remove a player after 120 seconds. Auto-play begins at the normal turn deadline and the seat remains recoverable until the room expires after seven days.
- Hand sorting is cosmetic client state, but discard selection order is authoritative: the last selected card lands on top and is the only discard card available to the next player.
- The persistent game history is public to room members but server-authored. It records public moves and scoring while intentionally omitting face-down deck-card identities.
- The initial release uses one standard 52-card deck, a maximum of five seats, a 10-point failed-Show penalty, and configurable 25–500 elimination / 15–120 second turn settings.
- Audio effects are optional in the specification. The UI includes a mute control and reduced-motion support; an audio asset pack is intentionally not bundled in the MVP.

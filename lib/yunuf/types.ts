export const SUITS = ["hearts", "diamonds", "clubs", "spades"] as const;
export const RANKS = ["A", "2", "3", "4", "5", "6", "7", "8", "9", "10", "J", "Q", "K"] as const;

export type Suit = typeof SUITS[number];
export type Rank = typeof RANKS[number];
export type Card = { id: string; suit: Suit; rank: Rank };
export type PlayType = "single" | "pair" | "sequence";
export type DiscardValidation =
  | { valid: true; playType: PlayType; orderedCards: Card[] }
  | { valid: false; error: string };

export type YunufPlayer = {
  id: string;
  name: string;
  avatar: number;
  seatIndex: number;
  hand: Card[];
  ready: boolean;
  connected: boolean;
  eliminated: boolean;
  totalScore: number;
  roundScore: number;
  handsWon: number;
  jointWins: number;
  showsDeclared: number;
  successfulShows: number;
  failedShows: number;
  revealHandTotalSum: number;
  reveals: number;
};

export type DiscardPlay = {
  id: string;
  playerId: string;
  cards: Card[];
  playType: PlayType;
  createdAt: number;
};

export type ShowState =
  | { active: false; declarerId: null; resolveAfterPlayerId: null; declaredAtTurnNumber: null }
  | { active: true; declarerId: string; resolveAfterPlayerId: string; declaredAtTurnNumber: number };

export type TurnPhase = "discard" | "draw" | "decision";
export type YunufStatus = "lobby" | "playing" | "finishing_round_after_show" | "hand_results" | "match_over";

export type HandResolution = {
  declarerId: string;
  handValues: Record<string, number>;
  winnerIds: string[];
  declarerWon: boolean;
  roundScores: Record<string, number>;
  eliminatedIds: string[];
  matchWinnerIds: string[];
};

export type YunufGameState = {
  status: YunufStatus;
  handNumber: number;
  players: YunufPlayer[];
  activePlayerIds: string[];
  currentPlayerId: string | null;
  startingPlayerId: string | null;
  turnNumber: number;
  turnPhase: TurnPhase;
  turnStartedAt: number | null;
  turnDurationSeconds: number;
  completedRounds: number;
  playersWhoActedThisRound: string[];
  drawPile: Card[];
  discardHistory: DiscardPlay[];
  latestDiscard: DiscardPlay | null;
  drawSourceDiscard: DiscardPlay | null;
  showState: ShowState;
  eliminationScore: number;
  failedShowPenalty: number;
  result: HandResolution | null;
};

export type YunufSession = { playerId: string; token: string; code: string; name: string; role: "host" | "guest" };
export type YunufViewPlayer = Omit<YunufPlayer, "hand"> & { hand?: Card[]; cardCount: number };
export type YunufViewState = Omit<YunufGameState, "players" | "drawPile"> & {
  roomId: string;
  code: string;
  version: number;
  hostPlayerId: string;
  you: { id: string; role: "host" | "guest" };
  players: YunufViewPlayer[];
  drawPileCount: number;
};

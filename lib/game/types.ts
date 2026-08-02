export type RoomStatus = "lobby" | "playing" | "round_result" | "finished";
export type PlayerRole = "host" | "guest";
export type RoundRole = "giver" | "guesser";
export type WordStatus = "active" | "guessed" | "skipped" | "pending";
export type GameMessageType = "clue" | "guess" | "wrong" | "correct" | "clue_request" | "clue_offer" | "skipped";

export interface GameMessage {
  id: string;
  senderId: string | null;
  wordIndex: number;
  type: GameMessageType;
  body: string | null;
  wordCount: number;
  createdAt: string;
  pending?: boolean;
}

export interface PublicPlayer {
  id: string;
  name: string;
  role: PlayerRole;
  avatar: number;
  ready: boolean;
  connected?: boolean;
  round1Score: number;
  round2Score: number;
}

export interface GameState {
  roomId: string;
  code: string;
  status: RoomStatus;
  currentRound: 1 | 2;
  currentWordIndex: number;
  cluesUsed: number;
  clueLimit: number;
  version: number;
  messages: GameMessage[];
  players: PublicPlayer[];
  you: { id: string; role: PlayerRole; roundRole: RoundRole | null };
  round: null | {
    giverId: string;
    guesserId: string;
    words: Array<{ index: number; word?: string; status: WordStatus }>;
    latestClue: string | null;
    score: number;
  };
}

export interface Session {
  playerId: string;
  token: string;
  code: string;
  name: string;
  role: PlayerRole;
}

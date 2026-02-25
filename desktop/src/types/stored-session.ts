/**
 * Shape of a session record stored in localStorage under 'ifb_sessions'.
 * Used for type-safe access when reading/writing raw localStorage data.
 */
export interface StoredSessionRecord {
  id: string;
  name: string;
  date?: string;
  mode?: string;
  participantCount?: number;
  participants?: string[];
  status?: string;
}

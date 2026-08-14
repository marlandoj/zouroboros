export interface Candidate { id:string; provider:string; family:string; health:"healthy"|"held" }
export function selectFallback(_failed:Candidate,_candidates:Candidate[]):Candidate|null { return null; }

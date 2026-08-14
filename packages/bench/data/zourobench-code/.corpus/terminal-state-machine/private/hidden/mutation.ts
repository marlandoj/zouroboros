export type State="queued"|"running"|"done"|"failed"; export function transition(_from:State,to:State):State{return to}

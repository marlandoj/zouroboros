import { getWorkspaceRoot } from 'zouroboros-core';
import { existsSync } from 'fs';
import { join } from 'path';
const WS = getWorkspaceRoot();
console.log('WS_ROOT=' + WS);
console.log('REPLAY_EXISTS=' + existsSync(join(WS, 'packages/bench/scripts/replay-regression.ts')));
console.log('REPLAY_ZB_EXISTS=' + existsSync(join(WS, 'zouroboros/packages/bench/scripts/replay-regression.ts')));
console.log('SEEDS_EXISTS=' + existsSync(join(WS, 'Seeds/zouroboros/snakepit')));
console.log('SEEDS_ZB_EXISTS=' + existsSync(join(WS, 'zouroboros/Seeds/zouroboros/snakepit')));

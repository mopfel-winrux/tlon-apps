import { createDevLogger } from '../lib/logger';
import type { Pikes } from './settingsApi';
import { scry } from './urbit';

const logger = createDevLogger('campfireApi', false);

// %campfire (https://github.com/mopfel-winrux/campfire) provides WebRTC
// calling agents (%rtcswitchboard, %icepond, %campfire). Call signalling
// itself lives in the web app (apps/tlon-web/src/campfire); this check gates
// call affordances on the desk being installed and running.
export const CAMPFIRE_DESK = 'campfire';

export async function checkCampfireInstalled(): Promise<boolean> {
  try {
    const pikes = await scry<Pikes>({ app: 'hood', path: '/kiln/pikes' });
    return pikes?.[CAMPFIRE_DESK]?.zest === 'live';
  } catch (e) {
    logger.log('failed to check for campfire desk', e);
    return false;
  }
}

import { RULES } from './protocol.js';
declare const __LAB_BUILD_ID__: string;
export const BUILD_ID = typeof __LAB_BUILD_ID__ === 'string' ? __LAB_BUILD_ID__ : `source-${RULES.version}`;

/*
 * Copyright © 2019 Lisk Foundation
 *
 * See the LICENSE file at the top-level directory of this distribution
 * for licensing information.
 *
 * Unless otherwise agreed in a custom licensing agreement with the Lisk Foundation,
 * no part of this software, including this file, may be copied, modified,
 * propagated, or distributed except according to the terms contained in the
 * LICENSE file.
 *
 * Removal or modification of this copyright notice is prohibited.
 */

import { applicationConfigSchema } from '../../src/application/schema';
import { deepFreeze } from './deep_freeze';
import { nodeOptions } from '../fixtures/node';

export const constants = deepFreeze({
	...applicationConfigSchema.default.genesisConfig,
	...nodeOptions.genesisConfig,
	rewards: {
		...applicationConfigSchema.default.genesisConfig.rewards,
		milestones: applicationConfigSchema.default.genesisConfig.rewards.milestones.map(r =>
			BigInt(r),
		),
	},
});

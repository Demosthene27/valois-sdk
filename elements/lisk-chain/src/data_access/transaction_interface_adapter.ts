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
import { BaseTransaction, TransactionJSON } from '@liskhq/lisk-transactions';

export interface RegisteredTransactions {
	readonly [key: string]: typeof BaseTransaction;
}

export class TransactionInterfaceAdapter {
	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	private readonly _transactionClassMap: Map<number, any>;

	public constructor(registeredTransactions: RegisteredTransactions = {}) {
		// eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
		this._transactionClassMap = new Map();
		Object.keys(registeredTransactions).forEach(transactionType => {
			this._transactionClassMap.set(
				Number(transactionType),
				registeredTransactions[transactionType],
			);
		});
	}

	public fromJSON(rawTx: TransactionJSON): BaseTransaction {
		// eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
		const TransactionClass = this._transactionClassMap.get(rawTx.type);

		if (!TransactionClass) {
			throw new Error('Transaction type not found.');
		}

		// eslint-disable-next-line @typescript-eslint/no-unsafe-return,@typescript-eslint/no-unsafe-call
		return new TransactionClass({
			...rawTx,
		});
	}
}

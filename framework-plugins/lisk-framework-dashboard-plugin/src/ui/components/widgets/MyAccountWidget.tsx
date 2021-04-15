/*
 * Copyright © 2021 Lisk Foundation
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

import * as React from 'react';
import { Widget, WidgetBody, WidgetHeader } from '../widget';
import { TableBody, TableHeader, Table } from '../Table';
import CopiableText from '../CopiableText';
import Text from '../Text';
import { Account } from '../../types';

interface MyAccountProps {
	accounts: ReadonlyArray<Account>;
	onSelect?: (account: Account) => void;
}

const MyAccountWidget: React.FC<MyAccountProps> = props => {
	const { accounts, onSelect } = props;

	const handleClick = (account: Account) => {
		if (onSelect) {
			onSelect(account);
		}
	};

	return (
		<Widget>
			<WidgetHeader>
				<Text type={'h2'}>My Accounts</Text>
			</WidgetHeader>
			<WidgetBody>
				<Table>
					<TableHeader sticky>
						<tr>
							<th>
								<Text>Binary addresss</Text>
							</th>
							<th>
								<Text>Public Key</Text>
							</th>
						</tr>
					</TableHeader>
					<TableBody>
						{accounts?.length ? (
							accounts.map((account: Account, index) => (
								<tr onClick={() => handleClick(account)} key={index}>
									<td>
										<CopiableText text={account.binaryAddress}>
											{account.binaryAddress}
										</CopiableText>
									</td>
									<td>
										<CopiableText text={account.publicKey}>{account.publicKey}</CopiableText>
									</td>
								</tr>
							))
						) : (
							<Text>You don't have any accounts</Text>
						)}
					</TableBody>
				</Table>
			</WidgetBody>
		</Widget>
	);
};

export default MyAccountWidget;

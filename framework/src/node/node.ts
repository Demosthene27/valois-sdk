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

import {
	Chain,
	events as chainEvents,
	GenesisBlock,
	Block,
	blockSchema,
	blockHeaderSchema,
	Account,
	AccountSchema,
	readGenesisBlockJSON,
	Transaction,
	transactionSchema,
} from '@liskhq/lisk-chain';
import { EVENT_BFT_BLOCK_FINALIZED, BFT } from '@liskhq/lisk-bft';
import { getNetworkIdentifier } from '@liskhq/lisk-cryptography';
import { TransactionPool, events as txPoolEvents } from '@liskhq/lisk-transaction-pool';
import { KVStore, NotFoundError } from '@liskhq/lisk-db';
import { Schema } from '@liskhq/lisk-codec';
import { jobHandlers } from '@liskhq/lisk-utils';
import { Forger } from './forger';
import {
	Transport,
	HandleRPCGetTransactionsReturn,
	handlePostTransactionReturn,
} from './transport';
import {
	Synchronizer,
	BlockSynchronizationMechanism,
	FastChainSwitchingMechanism,
} from './synchronizer';
import { Processor } from './processor';
import { Logger } from '../logger';
import { EventPostTransactionData, GenesisConfig, ApplicationConfig } from '../types';
import { InMemoryChannel } from '../controller/channels';
import { EventInfoObject } from '../controller/event';
import { ActionsDefinition } from '../controller/action';
import {
	EVENT_PROCESSOR_BROADCAST_BLOCK,
	EVENT_PROCESSOR_SYNC_REQUIRED,
} from './processor/processor';
import { EVENT_SYNCHRONIZER_SYNC_REQUIRED } from './synchronizer/base_synchronizer';
import { Network } from './network';
import { BaseModule } from '../modules';
import { Bus } from '../controller/bus';

const forgeInterval = 1000;
const { EVENT_NEW_BLOCK, EVENT_DELETE_BLOCK, EVENT_VALIDATORS_CHANGED } = chainEvents;
const { EVENT_TRANSACTION_REMOVED } = txPoolEvents;

export type NodeOptions = Omit<ApplicationConfig, 'plugins'>;

type InstantiableBaseModule = new (genesisConfig: GenesisConfig) => BaseModule;

interface NodeConstructor {
	readonly channel: InMemoryChannel;
	readonly genesisBlockJSON: Record<string, unknown>;
	readonly options: NodeOptions;
	readonly logger: Logger;
	readonly forgerDB: KVStore;
	readonly blockchainDB: KVStore;
	readonly nodeDB: KVStore;
	readonly customModules: InstantiableBaseModule[];
}

interface RegisteredSchema {
	readonly moduleID: number;
	readonly assetID: number;
	readonly schema: Schema;
}

interface TransactionFees {
	readonly minFeePerByte: number;
	readonly baseFees: {
		readonly moduleID: number;
		readonly assetID: number;
		readonly baseFee: string;
	}[];
}

export class Node {
	private _bus!: Bus;
	private readonly _channel: InMemoryChannel;
	private readonly _options: NodeOptions;
	private readonly _logger: Logger;
	private readonly _nodeDB: KVStore;
	private readonly _forgerDB: KVStore;
	private readonly _blockchainDB: KVStore;
	private readonly _customModules: InstantiableBaseModule[];
	private readonly _registeredModules: BaseModule[] = [];
	private readonly _genesisBlockJSON: Record<string, unknown>;
	private readonly _networkModule: Network;
	private _networkIdentifier!: Buffer;
	private _genesisBlock!: GenesisBlock;
	private _registeredAccountSchemas: { [moduleName: string]: AccountSchema } = {};
	private _chain!: Chain;
	private _bft!: BFT;
	private _processor!: Processor;
	private _synchronizer!: Synchronizer;
	private _transactionPool!: TransactionPool;
	private _transport!: Transport;
	private _forger!: Forger;
	private _forgingJob!: jobHandlers.Scheduler<void>;

	public constructor({
		channel,
		options,
		logger,
		blockchainDB,
		forgerDB,
		nodeDB,
		genesisBlockJSON,
		customModules,
	}: NodeConstructor) {
		this._channel = channel;
		this._options = options;
		this._logger = logger;
		this._blockchainDB = blockchainDB;
		this._forgerDB = forgerDB;
		this._nodeDB = nodeDB;
		this._customModules = customModules;
		this._genesisBlockJSON = genesisBlockJSON;
		this._networkModule = new Network({
			networkVersion: this._options.networkVersion,
			options: this._options.network,
			logger: this._logger,
			channel: this._channel,
			nodeDB: this._nodeDB,
		});
	}

	public async bootstrap(bus: Bus): Promise<void> {
		this._bus = bus;
		try {
			// eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
			if (!this._genesisBlockJSON) {
				throw Error('Missing genesis block');
			}

			for (const CustomModule of this._customModules) {
				const customModule = new CustomModule(this._options.genesisConfig);

				const exist = this._registeredModules.find(rm => rm.id === customModule.id);
				if (exist) {
					throw new Error(`Custom module with type ${customModule.id} already exists`);
				}
				if (customModule.accountSchema) {
					this._registeredAccountSchemas[customModule.name] = {
						...customModule.accountSchema,
						fieldNumber: customModule.id,
					};
				}
				this._registeredModules.push(customModule);
			}

			this._genesisBlock = readGenesisBlockJSON(
				this._genesisBlockJSON,
				this._registeredAccountSchemas,
			);

			if (this._options.forging.waitThreshold >= this._options.genesisConfig.blockTime) {
				throw Error(
					// eslint-disable-next-line @typescript-eslint/restrict-template-expressions
					`forging.waitThreshold=${this._options.forging.waitThreshold} is greater or equal to genesisConfig.blockTime=${this._options.genesisConfig.blockTime}. It impacts the forging and propagation of blocks. Please use a smaller value for forging.waitThreshold`,
				);
			}

			this._networkIdentifier = getNetworkIdentifier(
				this._genesisBlock.header.id,
				this._options.genesisConfig.communityIdentifier,
			);

			this._initModules();

			// TODO: Move custom Module initialization after _initModules() so that we don't need setDataAccess, related issue #5671
			for (const customModule of this._registeredModules) {
				this._processor.register(customModule);

				customModule.registerDataAccess({
					getAccount: async (address: Buffer) =>
						this._chain.dataAccess.getAccountByAddress(address),
					getChainState: async (key: string) => this._chain.dataAccess.getChainState(key),
				});

				const channel = new InMemoryChannel(
					customModule.name,
					customModule.events,
					(customModule.actions as unknown) as ActionsDefinition,
				);
				await channel.registerToBus(this._bus);
				// Give limited access of channel to custom module to publish events
				customModule.registerChannel({
					emit: (name: string, data?: object | undefined) => channel.publish(name, data),
				});
			}

			// Network needs to be initialized first to call events
			await this._networkModule.bootstrap(this.networkIdentifier);

			// Start subscribing to events, so that genesis block will also be included in event
			this._subscribeToEvents();
			// After binding, it should immediately load blockchain
			await this._processor.init(this._genesisBlock);
			// Check if blocks are left in temp_blocks table
			await this._synchronizer.init();

			this._networkModule.applyNodeInfo({
				height: this._chain.lastBlock.header.height,
				lastBlockID: this._chain.lastBlock.header.id,
				// eslint-disable-next-line @typescript-eslint/no-unsafe-assignment,@typescript-eslint/no-unsafe-member-access
				maxHeightPrevoted:
					// eslint-disable-next-line @typescript-eslint/no-unsafe-member-access
					this._chain.lastBlock.header.asset.maxHeightPrevoted ?? 0,
				blockVersion: this._chain.lastBlock.header.version,
			});

			this._logger.info('Node ready and launched');
			this._channel.subscribe(
				'app:network:ready',
				// eslint-disable-next-line @typescript-eslint/no-misused-promises
				async (_event: EventInfoObject) => {
					await this._startLoader();
				},
			);

			// eslint-disable-next-line @typescript-eslint/no-misused-promises
			this._channel.subscribe('app:ready', async (_event: EventInfoObject) => {
				await this._transactionPool.start();
				await this._startForging();
			});

			// Avoid receiving blocks/transactions from the network during snapshotting process
			this._channel.subscribe(
				'app:network:event',
				// eslint-disable-next-line @typescript-eslint/no-misused-promises
				async (info: EventInfoObject) => {
					const {
						data: { event, data, peerId },
					} = info as {
						data: { event: string; data: unknown; peerId: string };
					};
					try {
						if (event === 'postTransactionsAnnouncement') {
							await this._transport.handleEventPostTransactionsAnnouncement(data, peerId);
							return;
						}
						if (event === 'postBlock') {
							await this._transport.handleEventPostBlock(data, peerId);
							return;
						}
					} catch (err) {
						this._logger.warn(
							// eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
							{ err, event },
							'Received invalid event message',
						);
					}
				},
			);
		} catch (error) {
			this._logger.fatal(
				{
					message: (error as Error).message,
					stack: (error as Error).stack,
				},
				'Failed to initialization node',
			);
			throw error;
		}
	}

	public get networkIdentifier(): Buffer {
		return this._networkIdentifier;
	}

	// eslint-disable-next-line @typescript-eslint/explicit-module-boundary-types,@typescript-eslint/explicit-function-return-type
	public get actions() {
		return {
			getValidators: async (): Promise<
				ReadonlyArray<{ address: string; nextForgingTime: number }>
			> => {
				const validators = await this._chain.getValidators();
				const validatorAddresses = validators.map(v => v.address);
				const slot = this._chain.slots.getSlotNumber(Date.now());
				const startTime = this._chain.slots.getSlotTime(slot);

				let nextForgingTime = startTime;
				const slotInRound = slot % this._chain.numberOfValidators;
				const blockTime = this._chain.slots.blockTime();
				const forgersInfo = [];
				for (let i = slotInRound; i < slotInRound + this._chain.numberOfValidators; i += 1) {
					forgersInfo.push({
						address: validatorAddresses[i % validatorAddresses.length].toString('base64'),
						nextForgingTime,
					});
					nextForgingTime += blockTime;
				}

				return forgersInfo;
			},
			updateForgingStatus: async (params: {
				address: string;
				password: string;
				forging: boolean;
			}): Promise<{ address: string; forging: boolean }> => {
				const result = await this._forger.updateForgingStatus(
					Buffer.from(params.address, 'base64'),
					params.password,
					params.forging,
				);

				return {
					address: result.address.toString('base64'),
					forging: result.forging,
				};
			},
			getAccount: async (params: { address: string }): Promise<string> => {
				const account = await this._chain.dataAccess.getAccountByAddress(
					Buffer.from(params.address, 'base64'),
				);
				return this._chain.dataAccess.encodeAccount(account).toString('base64');
			},
			getAccounts: async (params: { address: readonly string[] }): Promise<readonly string[]> => {
				const accounts = await this._chain.dataAccess.getAccountsByAddress(
					params.address.map(address => Buffer.from(address, 'base64')),
				);
				return accounts.map(account =>
					this._chain.dataAccess.encodeAccount(account).toString('base64'),
				);
			},
			getBlockByID: async (params: { id: string }): Promise<string | undefined> => {
				const block = await this._chain.dataAccess.getBlockByID(Buffer.from(params.id, 'base64'));
				return this._chain.dataAccess.encode(block).toString('base64');
			},
			getBlocksByIDs: async (params: { ids: readonly string[] }): Promise<readonly string[]> => {
				const blocks = [];
				try {
					for (const id of params.ids) {
						const block = await this._chain.dataAccess.getBlockByID(Buffer.from(id, 'base64'));
						blocks.push(block);
					}
				} catch (error) {
					if (!(error instanceof NotFoundError)) {
						throw error;
					}
				}
				return blocks.map(block => this._chain.dataAccess.encode(block).toString('base64'));
			},
			getBlockByHeight: async (params: { height: number }): Promise<string | undefined> => {
				const block = await this._chain.dataAccess.getBlockByHeight(params.height);
				return this._chain.dataAccess.encode(block).toString('base64');
			},
			getBlocksByHeightBetween: async (params: {
				from: number;
				to: number;
			}): Promise<readonly string[]> => {
				const blocks = await this._chain.dataAccess.getBlocksByHeightBetween(
					params.from,
					params.to,
				);

				return blocks.map(b => this._chain.dataAccess.encode(b).toString('base64'));
			},
			getTransactionByID: async (params: { id: string }): Promise<string> => {
				const transaction = await this._chain.dataAccess.getTransactionByID(
					Buffer.from(params.id, 'base64'),
				);

				// eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
				return transaction.getBytes().toString('base64');
			},
			getTransactionsByIDs: async (params: { ids: readonly string[] }): Promise<string[]> => {
				const transactions = [];
				try {
					for (const id of params.ids) {
						const transaction = await this._chain.dataAccess.getTransactionByID(
							Buffer.from(id, 'base64'),
						);
						transactions.push(transaction);
					}
				} catch (error) {
					if (!(error instanceof NotFoundError)) {
						throw error;
					}
				}
				return transactions.map(tx => tx.getBytes().toString('base64'));
			},
			getTransactions: async (params: {
				data: unknown;
				peerId: string;
			}): Promise<HandleRPCGetTransactionsReturn> =>
				this._transport.handleRPCGetTransactions(params.data, params.peerId),
			getForgingStatus: (): { address: string; forging: boolean }[] | undefined =>
				this._forger.getForgingStatusOfAllDelegates()?.map(({ address, forging }) => ({
					address: address.toString('base64'),
					forging,
				})),
			getTransactionsFees: (): TransactionFees => this._getRegisteredTransactionFees(),
			getTransactionsFromPool: (): string[] =>
				this._transactionPool.getAll().map(tx => tx.getBytes().toString('base64')),
			postTransaction: async (
				params: EventPostTransactionData,
			): Promise<handlePostTransactionReturn> => this._transport.handleEventPostTransaction(params),
			// eslint-disable-next-line @typescript-eslint/require-await
			getLastBlock: async (): Promise<string> =>
				this._chain.dataAccess.encode(this._chain.lastBlock).toString('base64'),
			getBlocksFromId: async (params: { data: unknown; peerId: string }): Promise<string[]> =>
				this._transport.handleRPCGetBlocksFromId(params.data, params.peerId),
			getHighestCommonBlock: async (params: {
				data: unknown;
				peerId: string;
			}): Promise<string | undefined> =>
				this._transport.handleRPCGetGetHighestCommonBlock(params.data, params.peerId),
			// eslint-disable-next-line @typescript-eslint/explicit-function-return-type
			getSchema: () => ({
				accountSchema: this._chain.accountSchema,
				blockSchema,
				blockHeaderSchema,
				blockHeadersAssets: this._chain.blockAssetSchema,
				transactionSchema,
				transactionsAssetSchemas: this._getRegisteredTransactionSchemas(),
			}),
			// eslint-disable-next-line @typescript-eslint/explicit-function-return-type
			getNodeInfo: () => ({
				version: this._options.version,
				networkVersion: this._options.networkVersion,
				networkID: this._networkIdentifier.toString('base64'),
				lastBlockID: this._chain.lastBlock.header.id.toString('base64'),
				height: this._chain.lastBlock.header.height,
				finalizedHeight: this._bft.finalityManager.finalizedHeight,
				syncing: this._synchronizer.isActive,
				unconfirmedTransactions: this._transactionPool.getAll().length,
				genesisConfig: {
					...this._options.genesisConfig,
				},
			}),
			getConnectedPeers: () => this._networkModule.getConnectedPeers(),
			getDisconnectedPeers: () => this._networkModule.getDisconnectedPeers(),
		};
	}

	// eslint-disable-next-line @typescript-eslint/require-await
	public async cleanup(): Promise<void> {
		this._logger.info('Node cleanup started');
		this._transactionPool.stop();
		this._unsubscribeToEvents();
		if (this._forgingJob) {
			this._forgingJob.stop();
		}
		await this._synchronizer.stop();
		await this._processor.stop();
		this._logger.info('Node cleanup completed');
		await this._networkModule.cleanup();
	}

	private _initModules(): void {
		this._chain = new Chain({
			db: this._blockchainDB,
			genesisBlock: this._genesisBlock,
			networkIdentifier: this._networkIdentifier,
			maxPayloadLength: this._options.genesisConfig.maxPayloadLength,
			rewardDistance: this._options.genesisConfig.rewards.distance,
			rewardOffset: this._options.genesisConfig.rewards.offset,
			rewardMilestones: this._options.genesisConfig.rewards.milestones.map(s => BigInt(s)),
			blockTime: this._options.genesisConfig.blockTime,
			accountSchemas: this._registeredAccountSchemas,
		});

		this._bft = new BFT({
			chain: this._chain,
			threshold: this._options.genesisConfig.bftThreshold,
			genesisHeight: this._genesisBlock.header.height,
		});

		this._processor = new Processor({
			channel: this._channel,
			logger: this._logger,
			chainModule: this._chain,
			bftModule: this._bft,
		});

		this._transactionPool = new TransactionPool({
			baseFees: this._options.genesisConfig.baseFees.map(fees => ({
				...fees,
				baseFee: BigInt(fees.baseFee),
			})),
			minFeePerByte: this._options.genesisConfig.minFeePerByte,
			applyTransactions: async (transactions: Transaction[]) => {
				const stateStore = await this._chain.newStateStore();
				return this._processor.verifyTransactions(transactions, stateStore);
			},
		});

		const blockSyncMechanism = new BlockSynchronizationMechanism({
			logger: this._logger,
			bft: this._bft,
			channel: this._channel,
			chain: this._chain,
			processorModule: this._processor,
			networkModule: this._networkModule,
		});

		const fastChainSwitchMechanism = new FastChainSwitchingMechanism({
			logger: this._logger,
			channel: this._channel,
			chain: this._chain,
			bft: this._bft,
			processor: this._processor,
			networkModule: this._networkModule,
		});

		this._synchronizer = new Synchronizer({
			channel: this._channel,
			logger: this._logger,
			chainModule: this._chain,
			bftModule: this._bft,
			processorModule: this._processor,
			transactionPoolModule: this._transactionPool,
			mechanisms: [blockSyncMechanism, fastChainSwitchMechanism],
			networkModule: this._networkModule,
		});

		blockSyncMechanism.events.on(EVENT_SYNCHRONIZER_SYNC_REQUIRED, ({ block, peerId }) => {
			this._synchronizer.run(block, peerId).catch(err => {
				this._logger.error(
					{ err: err as Error },
					'Error occurred during block synchronization mechanism.',
				);
			});
		});

		fastChainSwitchMechanism.events.on(EVENT_SYNCHRONIZER_SYNC_REQUIRED, ({ block, peerId }) => {
			this._synchronizer.run(block, peerId).catch(err => {
				this._logger.error(
					{ err: err as Error },
					'Error occurred during fast chain synchronization mechanism.',
				);
			});
		});

		this._forger = new Forger({
			logger: this._logger,
			// eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
			db: this._forgerDB,
			bftModule: this._bft,
			transactionPoolModule: this._transactionPool,
			processorModule: this._processor,
			chainModule: this._chain,
			forgingDelegates: this._options.forging.delegates.map(delegate => ({
				...delegate,
				address: Buffer.from(delegate.address, 'base64'),
				hashOnion: {
					...delegate.hashOnion,
					hashes: delegate.hashOnion.hashes.map(h => Buffer.from(h, 'base64')),
				},
			})),
			forgingForce: this._options.forging.force,
			forgingDefaultPassword: this._options.forging.defaultPassword,
			forgingWaitThreshold: this._options.forging.waitThreshold,
		});

		this._transport = new Transport({
			channel: this._channel,
			logger: this._logger,
			synchronizer: this._synchronizer,
			transactionPoolModule: this._transactionPool,
			processorModule: this._processor,
			chainModule: this._chain,
			networkModule: this._networkModule,
		});
	}

	private async _startLoader(): Promise<void> {
		return this._synchronizer.loadUnconfirmedTransactions();
	}

	private async _forgingTask(): Promise<void> {
		try {
			if (!this._forger.delegatesEnabled()) {
				this._logger.trace('No delegates are enabled');
				return;
			}
			if (this._synchronizer.isActive) {
				this._logger.debug('Client not ready to forge');
				return;
			}
			await this._forger.forge();
		} catch (err) {
			this._logger.error({ err: err as Error });
		}
	}

	private async _startForging(): Promise<void> {
		try {
			await this._forger.loadDelegates();
		} catch (err) {
			this._logger.error({ err: err as Error }, 'Failed to load delegates for forging');
		}
		this._forgingJob = new jobHandlers.Scheduler(async () => this._forgingTask(), forgeInterval);
		// eslint-disable-next-line @typescript-eslint/no-floating-promises
		this._forgingJob.start();
	}

	private _subscribeToEvents(): void {
		this._chain.events.on(
			EVENT_NEW_BLOCK,
			// eslint-disable-next-line @typescript-eslint/no-misused-promises
			async (eventData: {
				block: Block;
				accounts: Account[];
				// eslint-disable-next-line @typescript-eslint/require-await
			}): Promise<void> => {
				const { block } = eventData;
				// Publish to the outside
				this._channel.publish('app:block:new', {
					block: this._chain.dataAccess.encode(block).toString('base64'),
					accounts: eventData.accounts.map(acc =>
						this._chain.dataAccess.encodeAccount(acc).toString('base64'),
					),
				});

				// Remove any transactions from the pool on new block
				if (block.payload.length) {
					for (const transaction of block.payload) {
						this._transactionPool.remove(transaction);
					}
				}

				if (!this._synchronizer.isActive) {
					this._networkModule.applyNodeInfo({
						height: block.header.height,
						lastBlockID: block.header.id,
						// eslint-disable-next-line @typescript-eslint/no-unsafe-assignment,@typescript-eslint/no-unsafe-member-access
						maxHeightPrevoted: block.header.asset.maxHeightPrevoted,
						blockVersion: block.header.version,
					});
				}

				this._logger.info(
					{
						id: block.header.id,
						height: block.header.height,
						numberOfTransactions: block.payload.length,
					},
					'New block added to the chain',
				);
			},
		);

		// eslint-disable-next-line @typescript-eslint/no-unsafe-call,@typescript-eslint/no-unsafe-member-access
		this._chain.events.on(
			EVENT_DELETE_BLOCK,
			// eslint-disable-next-line @typescript-eslint/no-misused-promises
			async (eventData: { block: Block; accounts: Account[] }) => {
				const { block } = eventData;
				// Publish to the outside
				this._channel.publish('app:block:delete', {
					block: this._chain.dataAccess.encode(block).toString('base64'),
					accounts: eventData.accounts.map(acc =>
						this._chain.dataAccess.encodeAccount(acc).toString('base64'),
					),
				});

				if (block.payload.length) {
					for (const transaction of block.payload) {
						try {
							await this._transactionPool.add(transaction);
						} catch (err) {
							this._logger.error(
								{ err: err as Error },
								'Failed to add transaction back to the pool',
							);
						}
					}
				}
				this._logger.info(
					{ id: block.header.id, height: block.header.height },
					'Deleted a block from the chain',
				);
			},
		);

		this._chain.events.on(
			EVENT_VALIDATORS_CHANGED,
			(eventData: {
				validators: [
					{
						address: Buffer;
						isConsensusParticipant: boolean;
						minActiveHeight: number;
					},
				];
			}): void => {
				const updatedValidatorsList = eventData.validators.map(aValidator => ({
					...aValidator,
					address: aValidator.address.toString('base64'),
				}));
				this._channel.publish('app:chain:validators:change', { validators: updatedValidatorsList });
			},
		);

		// FIXME: this event is using instance, it should be replaced by event emitter
		this._processor.events.on(
			EVENT_PROCESSOR_BROADCAST_BLOCK,
			// eslint-disable-next-line @typescript-eslint/no-misused-promises
			async ({ block }) => {
				await this._transport.handleBroadcastBlock(block);
			},
		);

		this._processor.events.on(EVENT_PROCESSOR_SYNC_REQUIRED, ({ block, peerId }) => {
			this._synchronizer.run(block, peerId).catch(err => {
				this._logger.error({ err: err as Error }, 'Error occurred during synchronization.');
			});
		});

		this._transactionPool.events.on(EVENT_TRANSACTION_REMOVED, event => {
			this._logger.debug(event, 'Transaction was removed from the pool.');
		});
	}

	private _unsubscribeToEvents(): void {
		this._bft.removeAllListeners(EVENT_BFT_BLOCK_FINALIZED);
	}
	private _getRegisteredTransactionSchemas(): RegisteredSchema[] {
		const registeredSchemas: RegisteredSchema[] = [];

		for (const customModule of this._registeredModules) {
			for (const customAsset of customModule.transactionAssets) {
				registeredSchemas.push({
					moduleID: customModule.id,
					assetID: customAsset.id,
					schema: customAsset.schema,
				});
			}
		}
		return registeredSchemas;
	}

	private _getRegisteredTransactionFees(): TransactionFees {
		const transactionFees: TransactionFees = {
			minFeePerByte: this._options.genesisConfig.minFeePerByte,
			baseFees: [],
		};

		for (const baseFeeInfo of this._options.genesisConfig.baseFees) {
			transactionFees.baseFees.push({
				moduleID: baseFeeInfo.moduleID,
				assetID: baseFeeInfo.assetID,
				baseFee: baseFeeInfo.baseFee,
			});
		}
		return transactionFees;
	}
}
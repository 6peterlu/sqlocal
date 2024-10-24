import coincident from 'coincident';
import type {
	CallbackUserFunction,
	ConfigMessage,
	DestroyMessage,
	FunctionMessage,
	ImportMessage,
	OmitQueryKey,
	OutputMessage,
	QueryKey,
	QueryMessage,
	RawResultData,
	Sqlite3Method,
	BatchMessage,
	WorkerProxy,
	ScalarUserFunction,
	GetInfoMessage,
	Statement,
	DatabaseInfo,
	ClientConfig,
	TransactionMessage,
	StatementInput,
	Transaction,
	DeleteMessage,
} from './types.js';
import { sqlTag } from './lib/sql-tag.js';
import { convertRowsToObjects } from './lib/convert-rows-to-objects.js';
import { normalizeStatement } from './lib/normalize-statement.js';
import { getQueryKey } from './lib/get-query-key.js';
import { normalizeSql } from './lib/normalize-sql.js';
import { parseDatabasePath } from './lib/parse-database-path.js';
import { mutationLock } from './lib/mutation-lock.js';

export class SQLocal {
	protected config: ClientConfig;
	protected clientKey: QueryKey;
	protected worker?: Worker;
	protected isWorkerDestroyed: boolean = false;
	protected bypassMutationLock: boolean = false;
	protected userCallbacks = new Map<string, CallbackUserFunction['func']>();
	protected queriesInProgress = new Map<
		QueryKey,
		[
			resolve: (message: OutputMessage) => void,
			reject: (error: unknown) => void,
		]
	>();

	protected proxy?: WorkerProxy;
	protected reinitChannel: BroadcastChannel;

	constructor(databasePath: string);
	constructor(config: ClientConfig);
	constructor(config: string | ClientConfig) {
		const clientConfig =
			typeof config === 'string' ? { databasePath: config } : config;
		this.config = clientConfig;
		this.clientKey = getQueryKey();

		const { onConnect, ...commonConfig } = clientConfig;
		const processorConfig = { ...commonConfig, clientKey: this.clientKey };

		this.reinitChannel = new BroadcastChannel(
			`_sqlocal_reinit_(${clientConfig.databasePath})`
		);

		if (typeof globalThis.Worker !== 'undefined') {
			this.worker = new Worker(new URL('./worker', import.meta.url), {
				type: 'module',
			});
			this.worker.addEventListener('message', this.processMessageEvent);

			this.proxy = coincident(this.worker) as WorkerProxy;
			this.worker.postMessage({
				type: 'config',
				config: processorConfig,
			} satisfies ConfigMessage);
		}
	}

	protected processMessageEvent = (
		event: MessageEvent<OutputMessage>
	): void => {
		const message = event.data;
		const queries = this.queriesInProgress;

		switch (message.type) {
			case 'success':
			case 'data':
			case 'error':
			case 'info':
				if (message.queryKey && queries.has(message.queryKey)) {
					const [resolve, reject] = queries.get(message.queryKey)!;
					if (message.type === 'error') {
						reject(message.error);
					} else {
						resolve(message);
					}
					queries.delete(message.queryKey);
				} else if (message.type === 'error') {
					throw message.error;
				}
				break;

			case 'callback':
				const userCallback = this.userCallbacks.get(message.name);

				if (userCallback) {
					userCallback(...(message.args ?? []));
				}
				break;

			case 'event':
				this.config.onConnect?.();
				break;
		}
	};

	protected createQuery = async (
		message: OmitQueryKey<
			| QueryMessage
			| BatchMessage
			| TransactionMessage
			| FunctionMessage
			| ImportMessage
			| GetInfoMessage
			| DeleteMessage
			| DestroyMessage
		>
	): Promise<OutputMessage> => {
		return await mutationLock(
			'shared',
			this.bypassMutationLock ||
				message.type === 'import' ||
				message.type === 'delete',
			this.config,
			async () => {
				if (!this.worker) {
					throw new Error(
						'This SQLocal client is not connected to a database. This is likely due to the client being initialized in a server-side environment.'
					);
				}

				if (this.isWorkerDestroyed === true) {
					throw new Error(
						'This SQLocal client has been destroyed. You will need to initialize a new client in order to make further queries.'
					);
				}

				const queryKey = getQueryKey();

				switch (message.type) {
					case 'import':
						this.worker.postMessage(
							{
								...message,
								queryKey,
							} satisfies ImportMessage,
							[message.database]
						);
						break;
					default:
						this.worker.postMessage({
							...message,
							queryKey,
						} satisfies
							| QueryMessage
							| BatchMessage
							| TransactionMessage
							| FunctionMessage
							| GetInfoMessage
							| DeleteMessage
							| DestroyMessage);
						break;
				}

				return await new Promise<OutputMessage>((resolve, reject) => {
					this.queriesInProgress.set(queryKey, [resolve, reject]);
				});
			}
		);
	};

	protected exec = async (
		sql: string,
		params: unknown[],
		method: Sqlite3Method = 'all',
		transactionKey?: QueryKey
	): Promise<RawResultData> => {
		const message = await this.createQuery({
			type: 'query',
			transactionKey,
			sql,
			params,
			method,
		});

		const data: RawResultData = {
			rows: [],
			columns: [],
		};

		if (message.type === 'data') {
			data.rows = message.data[0]?.rows ?? [];
			data.columns = message.data[0]?.columns ?? [];
		}

		return data;
	};

	protected execBatch = async (
		statements: Statement[]
	): Promise<RawResultData[]> => {
		const message = await this.createQuery({
			type: 'batch',
			statements,
		});
		const data = new Array(statements.length).fill({
			rows: [],
			columns: [],
		}) as RawResultData[];

		if (message.type === 'data') {
			message.data.forEach((result, resultIndex) => {
				data[resultIndex] = result;
			});
		}

		return data;
	};

	sql = async <Result extends Record<string, any>>(
		queryTemplate: TemplateStringsArray | string,
		...params: unknown[]
	): Promise<Result[]> => {
		const statement = normalizeSql(queryTemplate, params);
		const { rows, columns } = await this.exec(
			statement.sql,
			statement.params,
			'all'
		);
		const resultRecords = convertRowsToObjects(rows, columns);
		return resultRecords as Result[];
	};

	batch = async <Result extends Record<string, any>>(
		passStatements: (sql: typeof sqlTag) => Statement[]
	): Promise<Result[][]> => {
		const statements = passStatements(sqlTag);
		const data = await this.execBatch(statements);

		return data.map(({ rows, columns }) => {
			const resultRecords = convertRowsToObjects(rows, columns);
			return resultRecords as Result[];
		});
	};

	beginTransaction = async (): Promise<Transaction> => {
		const transactionKey = getQueryKey();

		await this.createQuery({
			type: 'transaction',
			transactionKey,
			action: 'begin',
		});

		const query = async <Result extends Record<string, any>>(
			passStatement: StatementInput<Result>
		): Promise<Result[]> => {
			const statement = normalizeStatement(passStatement);
			const { rows, columns } = await this.exec(
				statement.sql,
				statement.params,
				'all',
				transactionKey
			);
			const resultRecords = convertRowsToObjects(rows, columns) as Result[];
			return resultRecords;
		};

		const sql = async <Result extends Record<string, any>>(
			queryTemplate: TemplateStringsArray | string,
			...params: unknown[]
		): Promise<Result[]> => {
			const statement = normalizeSql(queryTemplate, params);
			const resultRecords = await query<Result>(statement);
			return resultRecords;
		};

		const commit = async (): Promise<void> => {
			await this.createQuery({
				type: 'transaction',
				transactionKey,
				action: 'commit',
			});
		};

		const rollback = async (): Promise<void> => {
			await this.createQuery({
				type: 'transaction',
				transactionKey,
				action: 'rollback',
			});
		};

		return {
			query,
			sql,
			commit,
			rollback,
		};
	};

	transaction = async <Result>(
		transaction: (tx: {
			sql: Transaction['sql'];
			query: Transaction['query'];
		}) => Promise<Result>
	): Promise<Result> => {
		return await mutationLock('exclusive', false, this.config, async () => {
			let tx: Transaction | undefined;
			this.bypassMutationLock = true;

			try {
				tx = await this.beginTransaction();
				const result = await transaction({
					sql: tx.sql,
					query: tx.query,
				});
				await tx.commit();
				return result;
			} catch (err) {
				await tx?.rollback();
				throw err;
			} finally {
				this.bypassMutationLock = false;
			}
		});
	};

	createCallbackFunction = async (
		funcName: string,
		func: CallbackUserFunction['func']
	): Promise<void> => {
		await this.createQuery({
			type: 'function',
			functionName: funcName,
			functionType: 'callback',
		});

		this.userCallbacks.set(funcName, func);
	};

	createScalarFunction = async (
		funcName: string,
		func: ScalarUserFunction['func']
	): Promise<void> => {
		await this.createQuery({
			type: 'function',
			functionName: funcName,
			functionType: 'scalar',
		});

		if (this.proxy) {
			this.proxy[`_sqlocal_func_${funcName}`] = func;
		}
	};

	getDatabaseInfo = async (): Promise<DatabaseInfo> => {
		const message = await this.createQuery({ type: 'getinfo' });

		if (message.type === 'info') {
			return message.info;
		} else {
			throw new Error('The database failed to return valid information.');
		}
	};

	getDatabaseFile = async (): Promise<File> => {
		const { directories, fileName, getDirectoryHandle } = parseDatabasePath(
			this.config.databasePath
		);
		const tempFileName = `backup-${Date.now()}--${fileName}`;
		const tempFilePath = `${directories.join('/')}/${tempFileName}`;

		await this.exec('VACUUM INTO ?', [tempFilePath]);

		const dirHandle = await getDirectoryHandle();
		const fileHandle = await dirHandle.getFileHandle(tempFileName);
		const file = await fileHandle.getFile();
		const fileBuffer = await file.arrayBuffer();
		await dirHandle.removeEntry(tempFileName);

		return new File([fileBuffer], fileName, {
			type: 'application/x-sqlite3',
		});
	};

	overwriteDatabaseFile = async (
		databaseFile:
			| File
			| Blob
			| ArrayBuffer
			| Uint8Array
			| ReadableStream<Uint8Array>,
		beforeUnlock?: () => void | Promise<void>
	): Promise<void> => {
		let database: ArrayBuffer | Uint8Array | ReadableStream<Uint8Array>;

		if (databaseFile instanceof Blob) {
			database = databaseFile.stream();
		} else {
			database = databaseFile;
		}

		await mutationLock('exclusive', false, this.config, async () => {
			try {
				await this.createQuery({
					type: 'import',
					database,
				});

				if (typeof beforeUnlock === 'function') {
					this.bypassMutationLock = true;
					await beforeUnlock();
				}

				this.reinitChannel.postMessage(this.clientKey);
			} finally {
				this.bypassMutationLock = false;
			}
		});
	};

	deleteDatabaseFile = async (
		beforeUnlock?: () => void | Promise<void>
	): Promise<void> => {
		await mutationLock('exclusive', false, this.config, async () => {
			try {
				await this.createQuery({
					type: 'delete',
				});

				if (typeof beforeUnlock === 'function') {
					this.bypassMutationLock = true;
					await beforeUnlock();
				}

				this.reinitChannel.postMessage(this.clientKey);
			} finally {
				this.bypassMutationLock = false;
			}
		});
	};

	destroy = async (): Promise<void> => {
		await this.createQuery({ type: 'destroy' });
		this.worker?.removeEventListener('message', this.processMessageEvent);
		this.queriesInProgress.clear();
		this.userCallbacks.clear();
		this.reinitChannel.close();
		this.worker?.terminate();
		this.isWorkerDestroyed = true;
	};
}

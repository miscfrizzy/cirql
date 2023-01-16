import { CirqlOptions, CirqlStatelessOptions, Params } from "./types";
import { CirqlCloseEvent, CirqlErrorEvent } from "../events";
import { SurrealHandle } from "../connection/types";
import { openConnection } from "../connection";
import { CirqlError } from "../errors";
import { CirqlBaseImpl } from "./base";

/**
 * A stateful connection to a Surreal database. This class provides full access
 * to all of Cirql's ORM functionality.
 * 
 * Events:
 * - connect: The connection is being established
 * - open: The connection was successfully opened 
 * - close: The connection was closed
 * - error: An error occured in the connection
 */
export class Cirql extends CirqlBaseImpl {

	readonly options: Required<CirqlOptions>;
	
	#surreal: SurrealHandle|null = null;
	#isPending: boolean = false;
	#isConnected: boolean = false;
	#retries: number = 0;
	#retryTask: any|undefined;

	constructor(options: CirqlOptions) {
		super({
			onQuery: (query, params) => this.handle!.query(query, params),
			onRequest: () => this.isConnected && !!this.handle,
			onLog: (query, params) => {
				if (this.options.logging) {
					this.options.logPrinter(query, params);
				}
			}
		});

		this.options = {
			autoConnect: true,
			logging: false,
			logPrinter: (query) => console.log(query),
			retryCount: 10,
			retryDelay: 2000,
			...options
		};
		
		if (options.autoConnect !== false) {
			this.connect();
		}
	}

	/**
	 * Returns whether the database is connected or not
	 */
	get isConnected() {
		return this.#isConnected && !this.#isPending;
	}

	/**
	 * Returns the underlying Surreal handle
	 */
	get handle() {
		return this.#surreal;
	}

	/**
	 * Manually open a connection to the Surreal database
	 */
	connect() {
		if (this.#isConnected || this.#isPending) {
			return;
		}

		this.dispatchEvent(new Event('connect'));

		this.#isPending = true;
		this.#surreal = openConnection({
			connection: this.options.connection,
			credentials: this.options.credentials,
			onConnect: () => {
				clearTimeout(this.#retryTask);

				this.#retries = 0;
				this.#retryTask = undefined;
				this.#isConnected = true;
				this.#isPending = false;
				this.dispatchEvent(new Event('open'));
			},
			onDisconnect: (error, reason) => {
				this.#isConnected = false;
				this.#isPending = false;
				this.dispatchEvent(new CirqlCloseEvent(error, reason));

				const { retryCount, retryDelay } = this.options;

				if (retryCount < 0 || (retryCount > 0 && this.#retries < retryCount)) {
					this.#retries++;
					this.#retryTask = setTimeout(() => this.connect(), retryDelay);
				}
			},
			onError: (error) => {
				this.dispatchEvent(new CirqlErrorEvent(error));
			}
		});
	}

	/**
	 * Terminate the active connection
	 */
	disconnect() {
		if (!this.#isConnected) {
			return;
		}

		this.#surreal?.close();
	}

}
 
/**
 * A stateless class used to send one-off queries to a Surreal database.
 * This class provides full access to all of Cirql's ORM functionality.
 */
export class CirqlStateless extends CirqlBaseImpl {

	readonly options: Required<CirqlStatelessOptions>;

	constructor(options: CirqlStatelessOptions) {
		super({
			onQuery: (query, params) => this.#executeQuery(query, params),
			onRequest: () => true,
			onLog: (query, params) => {
				if (this.options.logging) {
					this.options.logPrinter(query, params);
				}
			}
		});

		this.options = {
			logging: false,
			logPrinter: (query) => console.log(query),
			...options
		};
	}

	async #executeQuery(query: string, params: Params) {
		if (Object.keys(params).length > 0) {
			throw new CirqlError('Stateless queries do not support parameters yet. ', 'invalid_request');
		}

		const { endpoint, namespace, database } = this.options.connection;
		const { user, pass, DB, NS, SC, token } = this.options.credentials as any;

		const url = new URL('sql', endpoint);

		if (!user && !pass && !token) {
			throw new CirqlError('Missing username & password or token', 'invalid_request');
		}

		const authString = token
			? `Bearer ${token}`
			: `Basic ${btoa(`${user}:${pass}`)}`;

		const headers: Record<string, string> = {
			'User-Agent': 'Cirql',
			'Authorization': authString,
			'Accept': 'application/json'
		};

		// NOTE I have no idea what I'm supposed to do with the credentials DB and NS, since
		// in the WebSocket protocol they are seperate from the USE-related database and namespace (I think).

		if (NS || namespace) {
			headers['NS'] = NS || namespace;
		}

		if (DB || database) {
			headers['DB'] = DB || database;
		}

		if (SC) {
			headers['SC'] = SC;
		}

		const result = await fetch(url, {
			method: 'POST',
			headers: headers,
			body: query
		}).then(res => res.json());

		return result;
	}
	
}
/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import os from 'os'
import { Account, Accounts, AccountsDB } from './account'
import { Blockchain, IronfishBlockchain } from './blockchain'
import { IronfishVerifier } from './consensus/verifier'
import { Config, ConfigOptions, InternalStore } from './fileStores'
import { FileSystem } from './fileSystems'
import { createRootLogger, Logger } from './logger'
import { IronfishMemPool, MemPool } from './memPool'
import { MetricsMonitor } from './metrics'
import { MiningDirector } from './mining'
import { IronfishMiningDirector } from './mining/director'
import { PeerNetwork } from './network'
import { IsomorphicWebRtc, IsomorphicWebSocketConstructor } from './network/types'
import { RpcServer } from './rpc/server'
import { IronfishStrategy } from './strategy'
import { Syncer } from './syncer'
import { setDefaultTags, startCollecting, stopCollecting, submitMetric } from './telemetry'
import { WorkerPool } from './workerPool'

export class IronfishNode {
  chain: IronfishBlockchain
  strategy: IronfishStrategy
  config: Config
  internal: InternalStore
  accounts: Accounts
  logger: Logger
  miningDirector: IronfishMiningDirector
  metrics: MetricsMonitor
  memPool: IronfishMemPool
  workerPool: WorkerPool
  files: FileSystem
  rpc: RpcServer
  peerNetwork: PeerNetwork
  syncer: Syncer

  shutdownPromise: Promise<void> | null = null
  shutdownResolve: (() => void) | null = null

  private constructor({
    agent,
    chain,
    files,
    config,
    internal,
    accounts,
    strategy,
    metrics,
    miningDirector,
    memPool,
    workerPool,
    logger,
    webRtc,
    webSocket,
  }: {
    agent: string
    files: FileSystem
    config: Config
    internal: InternalStore
    accounts: Accounts
    chain: IronfishBlockchain
    strategy: IronfishStrategy
    metrics: MetricsMonitor
    miningDirector: IronfishMiningDirector
    memPool: IronfishMemPool
    workerPool: WorkerPool
    logger: Logger
    webRtc?: IsomorphicWebRtc
    webSocket: IsomorphicWebSocketConstructor
  }) {
    this.files = files
    this.config = config
    this.internal = internal
    this.accounts = accounts
    this.chain = chain
    this.strategy = strategy
    this.metrics = metrics
    this.miningDirector = miningDirector
    this.memPool = memPool
    this.workerPool = workerPool
    this.rpc = new RpcServer(this)
    this.logger = logger

    this.peerNetwork = new PeerNetwork({
      agent: agent,
      port: config.get('peerPort'),
      name: config.get('nodeName'),
      maxPeers: config.get('maxPeers'),
      minPeers: config.get('minPeers'),
      listen: config.get('enableListenP2P'),
      enableSyncing: config.get('enableSyncing'),
      targetPeers: config.get('targetPeers'),
      isWorker: config.get('isWorker'),
      broadcastWorkers: config.get('broadcastWorkers'),
      logPeerMessages: config.get('logPeerMessages'),
      simulateLatency: config.get('p2pSimulateLatency'),
      bootstrapNodes: config.getArray('bootstrapNodes'),
      webSocket: webSocket,
      webRtc: webRtc,
      node: this,
      chain: chain,
      strategy: strategy,
      metrics: this.metrics,
    })

    this.syncer = new Syncer({
      chain: chain,
      metrics: metrics,
      logger: logger,
      peerNetwork: this.peerNetwork,
      strategy: this.strategy,
    })

    this.config.onConfigChange.on((key, value) => this.onConfigChange(key, value))
    this.accounts.onDefaultAccountChange.on(this.onDefaultAccountChange)
  }

  static async init({
    agent,
    databaseName,
    dataDir,
    config,
    internal,
    autoSeed,
    logger = createRootLogger(),
    metrics,
    files,
    verifierClass,
    strategyClass,
    webRtc,
    webSocket,
  }: {
    agent: string
    dataDir?: string
    config?: Config
    internal?: InternalStore
    autoSeed?: boolean
    databaseName?: string
    logger?: Logger
    metrics?: MetricsMonitor
    files: FileSystem
    verifierClass: typeof IronfishVerifier | null
    strategyClass: typeof IronfishStrategy | null
    webRtc?: IsomorphicWebRtc
    webSocket: IsomorphicWebSocketConstructor
  }): Promise<IronfishNode> {
    logger = logger.withTag('ironfishnode')
    metrics = metrics || new MetricsMonitor(logger)

    if (!config) {
      config = new Config(files, dataDir)
      await config.load()
    }

    if (!internal) {
      internal = new InternalStore(files, dataDir)
      await internal.load()
    }

    if (databaseName) {
      config.setOverride('databaseName', databaseName)
    }

    const workerPool = new WorkerPool()

    strategyClass = strategyClass || IronfishStrategy
    const strategy = new strategyClass(workerPool, verifierClass)

    const chain = new Blockchain({
      location: config.chainDatabasePath,
      strategy,
      logger,
      metrics,
      autoSeed,
    })

    const memPool = new MemPool({ chain: chain, strategy: strategy, logger: logger })

    const accountDB = new AccountsDB({
      location: config.accountDatabasePath,
      workerPool,
      files,
    })

    const accounts = new Accounts({ database: accountDB, workerPool: workerPool, chain: chain })

    const mining = new MiningDirector({
      chain: chain,
      strategy: strategy,
      memPool: memPool,
      logger: logger,
      graffiti: config.get('blockGraffiti'),
      force: config.get('miningForce'),
    })

    const anonymousTelemetryId = Math.random().toString().substring(2)
    setDefaultTags({ version: agent, sessionId: anonymousTelemetryId })

    return new IronfishNode({
      agent,
      chain,
      strategy,
      files,
      config,
      internal,
      accounts,
      metrics,
      miningDirector: mining,
      memPool,
      workerPool,
      logger,
      webRtc,
      webSocket,
    })
  }

  async openDB(options?: { upgrade?: boolean }): Promise<void> {
    await this.files.mkdir(this.config.chainDatabasePath, { recursive: true })

    try {
      await this.chain.open(options)
      await this.accounts.db.open(options)
    } catch (e) {
      await this.chain.close()
      await this.accounts.db.close()
      throw e
    }

    await this.accounts.load()

    const defaultAccount = this.accounts.getDefaultAccount()
    this.miningDirector.setMinerAccount(defaultAccount)
  }

  async closeDB(): Promise<void> {
    await this.chain.db.close()
    await this.accounts.db.close()
  }

  async start(): Promise<void> {
    this.shutdownPromise = new Promise((r) => (this.shutdownResolve = r))

    // Work in the worker pool happens concurrently,
    // so we should start it as soon as possible
    let workers = this.config.get('nodeWorkers')
    if (workers === -1) {
      workers = os.cpus().length - 1
    }
    this.workerPool.start(workers)

    if (this.config.get('enableTelemetry')) {
      startCollecting(this.config.get('telemetryApi'))
    }

    if (this.config.get('enableMetrics')) {
      this.metrics.start()
    }

    this.accounts.start()
    this.peerNetwork.start()

    if (this.config.get('enableRpc')) {
      await this.rpc.start()
    }

    submitMetric({
      name: 'started',
      fields: [{ name: 'online', type: 'boolean', value: true }],
    })
  }

  async waitForShutdown(): Promise<void> {
    await this.shutdownPromise
  }

  async shutdown(): Promise<void> {
    await Promise.allSettled([
      this.accounts.stop(),
      this.syncer.stop(),
      this.peerNetwork.stop(),
      this.rpc.stop(),
      stopCollecting(),
      this.metrics.stop(),
      this.workerPool.stop(),
      this.miningDirector.shutdown(),
    ])

    if (this.shutdownResolve) {
      this.shutdownResolve()
    }
  }

  onPeerNetworkReady(): void {
    if (this.config.get('enableSyncing')) {
      void this.syncer.start()
    }

    if (this.config.get('enableMiningDirector')) {
      void this.miningDirector.start()
    }
  }

  onPeerNetworkNotReady(): void {
    void this.syncer.stop()
    this.miningDirector.shutdown()
  }

  onDefaultAccountChange = (account: Account | null): void => {
    this.miningDirector.setMinerAccount(account)
  }

  async onConfigChange<Key extends keyof ConfigOptions>(
    key: Key,
    newValue: ConfigOptions[Key],
  ): Promise<void> {
    switch (key) {
      case 'blockGraffiti': {
        this.miningDirector.setBlockGraffiti(this.config.get('blockGraffiti'))
        break
      }
      case 'enableTelemetry': {
        if (newValue) {
          startCollecting(this.config.get('telemetryApi'))
        } else {
          await stopCollecting()
        }
        break
      }
      case 'enableMetrics': {
        if (newValue) {
          this.metrics.start()
        } else {
          this.metrics.stop()
        }
        break
      }
      case 'enableRpc': {
        if (newValue) {
          await this.rpc.start()
        } else {
          await this.rpc.stop()
        }
        break
      }
      case 'enableMiningDirector': {
        if (newValue && this.peerNetwork.isReady) {
          void this.miningDirector.start()
        } else {
          this.miningDirector.shutdown()
        }
        break
      }
    }
  }
}

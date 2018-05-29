import * as d from '../../../declarations';
import { CallItem, MessageData, Runner, Worker, WorkerOptions } from './interface';
import { cpus } from 'os';
import { fork } from 'child_process';


export class WorkerFarm {
  options: WorkerOptions;
  modulePath: string;
  workerModule: any;
  workers: Worker[] = [];
  callQueue: CallItem[] = [];
  isExisting = false;
  logger: d.Logger;
  singleThreadRunner: Runner;

  constructor(modulePath: string, options: WorkerOptions = {}) {
    this.options = Object.assign({}, DEFAULT_OPTIONS, options);
    this.modulePath = modulePath;
    this.logger = {
      error: function() {
        console.error.apply(console, arguments);
      }
    } as any;

    if (this.options.maxConcurrentWorkers > 1) {
      this.startWorkers();

    } else {
      this.workerModule = require(modulePath);
      this.singleThreadRunner = new this.workerModule.createRunner();
    }
  }

  run(methodName: string, args?: any[]) {
    if (this.isExisting) {
      return Promise.reject(`process exited`);
    }

    if (this.singleThreadRunner) {
      return this.singleThreadRunner(methodName, args);
    }

    return new Promise<any>((resolve, reject) => {
      const call: CallItem = {
        methodName: methodName,
        args: args,
        resolve: resolve,
        reject: reject
      };
      this.callQueue.push(call);
      this.processQueue();
    });
  }

  startWorkers() {
    for (let workerId = 0; workerId < this.options.maxConcurrentWorkers; workerId++) {
      const worker = this.createWorker(workerId);

      worker.calls = [];
      worker.totalCallsAssigned = 0;

      this.workers.push(worker);
    }

    process.once('exit', this.destroy.bind(this));
  }

  createWorker(workerId: number) {
    const options = Object.assign({
      env: process.env,
      cwd: process.cwd()
    }, this.options.forkOptions);

    const argv = [
      '--start-worker'
    ];

    const childProcess = fork(this.modulePath, argv, options);

    const worker: Worker = {
      workerId: workerId,
      callIds: 0,
      send: (msg: MessageData) => childProcess.send(msg),
      kill: () => childProcess.kill('SIGKILL')
    };

    childProcess.on('message', this.receiveFromWorker.bind(this));

    childProcess.once('exit', code => {
      this.onWorkerExit(workerId, code);
    });

    childProcess.on('error', () => {/**/});

    return worker;
  }

  onWorkerExit(workerId: number, exitCode: number) {
    const worker = this.workers.find(w => w.workerId === workerId);
    if (!worker) {
      return;
    }

    worker.exitCode = exitCode;

    setTimeout(() => {
      const worker = this.workers.find(w => w.workerId === workerId);
      if (worker) {
        worker.calls.forEach(call => {
          this.receiveFromWorker({
            callId: call.callId,
            workerId: workerId,
            error: {
              message: `Worker exited. Canceled "${call.methodName}" call.`
            }
          });
        });
      }

      this.stopWorker(workerId);
    }, 10);
  }

  stopWorker(workerId: number) {
    const worker = this.workers.find(w => w.workerId === workerId);
    if (worker && !worker.isExisting) {
      worker.isExisting = true;

      worker.send({
        exitProcess: true
      });

      const tmr = setTimeout(() => {
        if (worker.exitCode == null) {
          worker.kill();
        }
      }, this.options.forcedKillTime);

      tmr.unref && tmr.unref();

      const index = this.workers.indexOf(worker);
      if (index > -1) {
        this.workers.splice(index, 1);
      }
    }
  }

  receiveFromWorker(msg: MessageData) {
    // called from a worker process, the data contains information needed to
    // look up the worker and the original call so we can invoke the callback
    const worker = this.workers.find(w => w.workerId === msg.workerId);
    if (!worker) {
      this.logger.error(`Worker Farm: Received message for unknown worker(${msg.workerId})`);
      return;
    }

    const call = worker.calls.find(w => w.callId === msg.callId);
    if (!call) {
      this.logger.error(`Worker Farm: Received message for unknown callId (${msg.callId}) for worker(${worker.workerId})`);
      return;
    }

    if (call.timer) {
      clearTimeout(call.timer);
    }

    const index = worker.calls.indexOf(call);
    if (index > -1) {
      worker.calls.splice(index, 1);
    }

    process.nextTick(() => {
      if (msg.error) {
        call.reject(msg.error.message);
      } else {
        call.resolve(msg.value);
      }

      // overkill yes, but let's ensure we've cleaned up this call
      call.args = null;
      call.reject = null;
      call.resolve = null;
      call.timer = null;
    });

    // allow any outstanding calls to be processed
    this.processQueue();
  }

  workerTimeout(workerId: number) {
    const worker = this.workers.find(w => w.workerId === workerId);
    if (!worker) {
      return;
    }

    worker.calls.forEach(call => {
      this.receiveFromWorker({
        callId: call.callId,
        workerId: workerId,
        error: {
          message: `worker call timed out!`
        }
      });
    });

    this.stopWorker(workerId);
  }

  processQueue() {
    while (this.callQueue.length > 0) {
      const worker = nextAvailableWorker(this.workers, this.options.maxConcurrentCallsPerWorker);
      if (worker) {
        this.send(worker, this.callQueue.shift());

      } else {
        // no worker available ATM
        break;
      }
    }
  }

  send(worker: Worker, call: CallItem) {
    if (!worker || !call) {
      return;
    }

    call.callId = worker.callIds++;

    worker.calls.push(call);
    worker.totalCallsAssigned++;

    worker.send({
      workerId: worker.workerId,
      callId: call.callId,
      methodName: call.methodName,
      args: call.args
    });

    // no need to keep these args in memory at this point
    call.args = null;

    if (this.options.maxCallTime !== Infinity) {
      call.timer = setTimeout(this.workerTimeout.bind(this, worker.workerId), this.options.maxCallTime);
    }
  }

  destroy() {
    if (!this.isExisting) {
      this.isExisting = true;

      for (let i = this.workers.length - 1; i >= 0; i--) {
        this.stopWorker(this.workers[i].workerId);
      }
    }
  }

}


export function nextAvailableWorker(workers: Worker[], maxConcurrentCallsPerWorker: number) {
  const availableWorkers = workers.filter(w => w.calls.length < maxConcurrentCallsPerWorker);
  if (availableWorkers.length === 0) {
    // all workers are pretty tasked at the moment, please come back later. Thank you.
    return null;
  }

  const sorted = availableWorkers.sort((a, b) => {
    // worker with the fewest active calls first
    if (a.calls.length < b.calls.length) return -1;
    if (a.calls.length > b.calls.length) return 1;

    // all workers have the same number of active calls, so next sort
    // by worker with the fewest total calls that have been assigned
    if (a.totalCallsAssigned < b.totalCallsAssigned) return -1;
    if (a.totalCallsAssigned > b.totalCallsAssigned) return 1;

    return 0;
  });

  return sorted[0];
}


const DEFAULT_OPTIONS: WorkerOptions = {
  forkOptions: {},
  maxConcurrentWorkers: (cpus() || { length: 1 }).length,
  maxConcurrentCallsPerWorker: 5,
  maxCallTime: 90000,
  forcedKillTime: 100
};
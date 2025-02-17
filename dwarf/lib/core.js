/**
 Dwarf - Copyright (C) 2019 Giovanni Rocca (iGio90)

 This program is free software: you can redistribute it and/or modify
 it under the terms of the GNU General Public License as published by
 the Free Software Foundation, either version 3 of the License, or
 (at your option) any later version.

 This program is distributed in the hope that it will be useful,
 but WITHOUT ANY WARRANTY; without even the implied warranty of
 MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
 GNU General Public License for more details.

 You should have received a copy of the GNU General Public License
 along with this program.  If not, see <https://www.gnu.org/licenses/>
 **/

/**
 * those are meant to be exposed
 */
var BREAK_START = false;
var DEBUG = false;
var SPAWNED = false;

var api = null;
var dwarf = null;
var fs = null;
var javaHelper = null;

// reasons are used to switch hooks type
var REASON_SET_INITIAL_CONTEXT = -1;
// any reason > -1 must have context in otherwise bad things will happens
var REASON_BREAKPOINT = 0;
var REASON_WATCHER = 1;
var REASON_BREAKPOINT_NATIVE_ONLOAD = 2;
var REASON_STEP = 3;

// const
var MEMORY_ACCESS_READ = 1;
var MEMORY_ACCESS_WRITE = 2;
var MEMORY_ACCESS_EXECUTE = 4;
var MEMORY_WATCH_SINGLESHOT = 8;

// utils
function isDefined(value) {
    return (value !== undefined) && (value !== null) && (typeof value !== 'undefined');
}

function isNumber(value) {
    if (isDefined(value)) {
        return (typeof value === "number" && (isNaN(value) === false));
    }
    return false;
}

function isString(value) {
    if (isDefined(value)) {
        return (typeof value === "string");
    }
    return false;
}

function ba2hex(b) {
    var uint8arr = new Uint8Array(b);
    if (!uint8arr) {
        return '';
    }
    var hexStr = '';
    for (var i = 0; i < uint8arr.length; i++) {
        var hex = (uint8arr[i] & 0xff).toString(16);
        hex = (hex.length === 1) ? '0' + hex : hex;
        hexStr += hex;
    }
    return hexStr;
}

function hex2a(hex) {
    for (var bytes = [], c = 0; c < hex.length; c += 2)
        bytes.push(parseInt(hex.substr(c, 2), 16));
    return bytes;
}

function dethumbify(pt) {
    pt = ptr(pt);
    if (Process.arch.indexOf('arm') !== -1) {
        if (parseInt(pt) & 1 === 1) {
            pt = pt.sub(1);
        }
    }
    return pt;
}

function uniqueBy(array) {
    var seen = {};
    return array.filter(function (item) {
        var k = JSON.stringify(item);
        return seen.hasOwnProperty(k) ? false : (seen[k] = true);
    });
}

// static dwarf instance
function getDwarf() {
    if (dwarf === null) {
        dwarf = new Dwarf();
    }

    return dwarf;
}

// js needleds
Date.prototype.getTwoDigitHour = function () {
    return (this.getHours() < 10) ? '0' + this.getHours() : this.getHours();
};

Date.prototype.getTwoDigitMinute = function () {
    return (this.getMinutes() < 10) ? '0' + this.getMinutes() : this.getMinutes();
};

Date.prototype.getTwoDigitSecond = function () {
    return (this.getSeconds() < 10) ? '0' + this.getSeconds() : this.getSeconds();
};

Date.prototype.getHourMinuteSecond = function () {
    return this.getTwoDigitHour() + ':' + this.getTwoDigitMinute() + ':' + this.getTwoDigitSecond();
};

function Dwarf() {
    this.proc_resumed = false;
    this.native_contexts = {};
    this.hook_contexts = {};
    this.hooks = {};
    this.nativeOnLoads = {};
    this.javaOnLoads = {};
    this.java_handlers = {};
    this.memory_watchers = {};
    this.memory_addresses = [];
    this.stalker_info = {};

    // setup pc register
    this.procedure_call_register = null;
    if (Process.arch === 'arm' || Process.arch === 'arm64') {
        this.procedure_call_register = 'pc'
    } else if (Process.arch === 'ia32') {
        this.procedure_call_register = 'eip';
    } else if (Process.arch === 'x64') {
        this.procedure_call_register = 'rip';
    }

    this.breakpoint = function (reason, p, context, hook, java_handle) {
        const tid = Process.getCurrentThreadId();

        if (isDefined(getDwarf().hook_contexts[tid])) {
            console.log('thread ' + tid + ' is already break');
            return;
        }

        if (!isDefined(reason)) {
            reason = REASON_BREAKPOINT;
        }

        if (!isDefined(p) && !isDefined(context)) {
            context = getDwarf().native_contexts[tid];
            if (isDefined(context)) {
                p = context.pc;
            }
        }

        if (DEBUG) {
            _log('[' + tid + '] break ' + p + ' - reason: ' + reason);
        }

        var that = {};
        var shouldSleep = true;
        var proxiedContext = null;

        if (context !== null) {
            proxiedContext = new Proxy(context, {
                get: function (object, prop) {
                    return object[prop];
                },
                set: function (object, prop, value) {
                    if (DEBUG) {
                        _log('[' + tid + '] setting context ' + prop + ': ' + value);
                    }
                    send('set_context_value:::' + prop + ':::' + value);
                    object[prop] = value;
                    return true;
                }
            });
        }

        that['context'] = proxiedContext;
        that['handle'] = java_handle;

        if (DEBUG) {
            _log('[' + tid + '] break ' + p + ' - creating dwarf context');
        }

        var hc = new HookContext(tid);
        hc.context = context;
        hc.java_handle = java_handle;
        that['hook_context'] = hc;
        getDwarf().hook_contexts[hc.tid] = hc;

        var hookKey = null;
        if (hook !== null) {
            // we detach native interceptors to fix the function bytes
            // re-attach later
            if (isDefined(hook.interceptor)) {
                hookKey = hook.nativePtr;
                hook.interceptor.detach();
                wrappedInterceptor.flush();
            }

            if (hook.condition !== null) {
                try {
                    //todo: check here 'this' is dwarf() and has no context prop
                    this.context = that['context'];
                    var res = eval(hook.condition);
                    if (res !== null && typeof (res) === 'boolean') {
                        if (!res) {
                            return null;
                        }
                    }
                } catch (e) {
                    _log_err('break', e);
                }
            }

            // we want to run the logic only in onload hooks, normal hooks already handle logic in Interceptor impl
            if (isDefined(hook.logic)) {
                try {
                    var logic = null;
                    if (typeof hook.logic === 'string') {
                        logic = new Function(hook.logic);
                    } else if (typeof hook.logic === 'function') {
                        logic = hook.logic;
                    }

                    if (isDefined(logic)) {
                        var ret;

                        if (isDefined(hook.interceptorArgs)) {
                            ret = logic.call(that, hook.interceptorArgs);
                        } else {
                            ret = logic.call(that, context);
                        }

                        if (typeof ret !== 'undefined') {
                            shouldSleep = ret !== -1;
                        }
                    }
                } catch (e) {
                    _log_err('break', e);
                }
            }
        }

        if (DEBUG) {
            _log('[' + tid + '] break ' + p + ' - pre-sleep: ' + shouldSleep + ' hc-sleep: ' + hc.prevent_sleep);
        }

        // check if .logic() used an api which isn't friend with sleep
        if (hc.prevent_sleep) {
            shouldSleep = false;
        }

        if (shouldSleep) {
            if (DEBUG) {
                _log('[' + tid + '] break ' + p + ' - dispatching context info');
            }

            getDwarf().sendInfos(reason, p, context, hook);

            if (DEBUG) {
                _log('[' + tid + '] break ' + p + ' - sleeping context. goodnight!');
            }

            getDwarf().loopApi(that);

            if (DEBUG) {
                _log('[' + tid + '] HookContext has been released');
            }

            loggedSend('release:::' + tid + ':::' + reason);
        }

        delete getDwarf().hook_contexts[hc.tid];

        if (isDefined(hookKey) && isDefined(getDwarf().hooks[hookKey])) {
            if (DEBUG) {
                _log('[' + tid + '] attaching back hook at: ' + hookKey);
            }
            DwarfInterceptor.attach(hook);
        }
    };

    this.breakModuleLoading = function (moduleName) {
        if (!isString(moduleName)) {
            return;
        }

        //TODO: add blacklisted modules somewhere
        if (Process.platform === 'windows') {
            if (moduleName === 'ntdll.dll') {
                return;
            }
        } else if (Process.platform === 'linux') {
            if (javaHelper !== null) {
                if (javaHelper._sdk <= 23) {
                    if (moduleName === 'app_process') {
                        return;
                    }
                }
            }
        }

        var m = Process.findModuleByName(moduleName);
        if (m === null) {
            m = {'name': moduleName, 'base': '0x0', 'size': 0, 'path':'', 'imports': [], 'exports': [], 'symbols':[]};
            return;
        } else {
            m = api.enumerateModuleInfo(m);
        }
        var tid = Process.getCurrentThreadId();
        loggedSend('native_on_load_module_loading:::' + tid + ':::' + JSON.stringify(m));
        for (var s in getDwarf().nativeOnLoads) {
            if (moduleName.indexOf(s) >= 0) {
                var hook = getDwarf().nativeOnLoads[s];
                hook.moduleBase = ptr(m['base']);
                hook.moduleEntry = m['entry'];
                if (typeof hook !== 'undefined') {
                    loggedSend("native_on_load_callback:::" + tid + ':::' + JSON.stringify(hook));
                    getDwarf().hooks[hook.moduleBase] = hook;
                    getDwarf().breakpoint(REASON_BREAKPOINT_NATIVE_ONLOAD, this.context.pc, this.context, hook, null);
                }
            }
        }

    };

    this.handleException = function (exception) {
        if (DEBUG) {
            var dontLog = false;
            if (Process.platform === 'windows') {
                // hide SetThreadName - https://github.com/frida/glib/blob/master/glib/gthread-win32.c#L579
                var reg = null;
                if (Process.arch === 'x64') {
                    reg = exception['context']['rax'];
                } else if (Process.arch === 'ia32') {
                    reg = exception['context']['eax'];
                }
                if (reg !== null && reg.readInt() === 0x406d1388) {
                    dontLog = true;
                }
            }
            if(!dontLog) {
                _log('[' + Process.getCurrentThreadId() + '] exception handler: ' + JSON.stringify(exception));
            }
        }
        var tid = Process.getCurrentThreadId();
        var watcher = null;

        if (exception['type'] === 'illegal-instruction') {
            // Stalker on windows was throwing this when cpu doesnt support avx2 instruction set
            // https://github.com/frida/frida-gum/issues/326
            // TODO: Stalker.unfollow(???)
            return true;
        }

        if (Process.platform === 'windows') {
            if (exception['type'] === 'access-violation') {
                return true;
            }
        }

        // watchers
        if (Object.keys(getDwarf().memory_watchers).length > 0) {
            // make sure it's access violation
            if (exception['type'] === 'access-violation') {
                watcher = getDwarf().memory_watchers[exception['memory']['address']];
                if (typeof watcher !== 'undefined') {
                    if (typeof exception['memory']['operation'] !== 'undefined') {
                        var operation = exception['memory']['operation'];
                        if ((watcher.flags & MEMORY_ACCESS_READ) && (operation === 'read')) {
                            watcher.restore();
                            loggedSend('watcher:::' + JSON.stringify(exception) + ':::' + tid);
                        } else if ((watcher.flags & MEMORY_ACCESS_WRITE) && (operation === 'write')) {
                            watcher.restore();
                            loggedSend('watcher:::' + JSON.stringify(exception) + ':::' + tid);
                        } else if ((watcher.flags & MEMORY_ACCESS_EXECUTE) && (operation === 'execute')) {
                            watcher.restore();
                            loggedSend('watcher:::' + JSON.stringify(exception) + ':::' + tid);
                        } else {
                            watcher = null;
                        }
                    } else {
                        watcher.restore();
                        loggedSend('watcher:::' + JSON.stringify(exception) + ':::' + tid);
                    }
                } else {
                    watcher = null;
                }
            }
        }

        if (watcher !== null) {
            getDwarf().breakpoint(REASON_WATCHER, hook.nativePtr, this.context, null, null);
            if (!(watcher.flags & MEMORY_WATCH_SINGLESHOT)) {
                watcher.watch();
            }
        }
        return watcher !== null;
    };

    this.hitPreventRelease = function () {
        const tid = Process.getCurrentThreadId();
        const hc = getDwarf().hook_contexts[tid];
        if (isDefined(hc)) {
            hc.prevent_sleep = true;
        }
    };

    this.loopApi = function (that) {
        const tid = Process.getCurrentThreadId();

        if (DEBUG) {
            _log('[' + tid + '] looping api');
        }

        var op = recv('' + tid, function (payload) {});
        op.wait();

        const hook_context = that['hook_context'];

        if (typeof hook_context !== 'undefined') {
            while (hook_context.api_queue.length === 0) {
                if (DEBUG) {
                    _log('[' + tid + '] waiting api queue to be populated');
                }
                Thread.sleep(0.2);
            }

            var release = false;

            while (hook_context.api_queue.length > 0) {
                var hook_api = hook_context.api_queue.shift();
                if (DEBUG) {
                    _log('[' + tid + '] executing ' + hook_api.api_funct);
                }
                try {
                    if (isDefined(api[hook_api.api_funct])) {
                        hook_api.result = api[hook_api.api_funct].apply(that, hook_api.args);
                    } else {
                        hook_api.result = '';
                    }
                } catch (e) {
                    hook_api.result = null;
                    if (DEBUG) {
                        _log('[' + tid + '] error executing ' +
                            hook_api.api_funct + ':\n' + e);
                    }
                }
                hook_api.consumed = true;

                if (hook_api.api_funct === '_step') {
                    release = true;
                    break
                } else if (hook_api.api_funct === 'release') {
                    const stalkerInfo = getDwarf().stalker_info[tid];
                    if (isDefined(stalkerInfo)) {
                        stalkerInfo.terminated = true;
                    }

                    release = true;
                    break;
                }
            }

            if (!release) {
                getDwarf().loopApi(that);
            }
        }
    };

    this.onMemoryAccess = function (details) {
        var tid = Process.getCurrentThreadId();
        var watcher = null;
        var operation = details.operation; // 'read' - 'write' - 'execute'
        var fromPtr = details.from;
        var address = details.address;

        // watchers
        if (Object.keys(getDwarf().memory_watchers).length > 0) {
            watcher = getDwarf().memory_watchers[address];
            if (typeof watcher !== 'undefined') {
                var returnval = { 'memory': { 'operation': operation, 'address': address } };
                if ((watcher.flags & MEMORY_ACCESS_READ) && (operation === 'read')) {
                    MemoryAccessMonitor.disable();
                    loggedSend('watcher:::' + JSON.stringify(returnval) + ':::' + tid);
                } else if ((watcher.flags & MEMORY_ACCESS_WRITE) && (operation === 'write')) {
                    MemoryAccessMonitor.disable();
                    loggedSend('watcher:::' + JSON.stringify(returnval) + ':::' + tid);
                } else if ((watcher.flags & MEMORY_ACCESS_EXECUTE) && (operation === 'execute')) {
                    MemoryAccessMonitor.disable();
                    loggedSend('watcher:::' + JSON.stringify(returnval) + ':::' + tid);
                } else {
                    watcher = null;
                }
            } else {
                watcher = null;
            }
        }
        if (watcher !== null) {
            var hook = new Hook();
            hook.nativePtr = fromPtr;
            hook.interceptor = Interceptor.attach(fromPtr, function () {
                getDwarf().breakpoint(REASON_WATCHER, hook.nativePtr, this.context, hook, null);
                if (!(watcher.flags & MEMORY_WATCH_SINGLESHOT)) {
                    MemoryAccessMonitor.enable(this.memory_addresses, { onAccess: getDwarf().onMemoryAccess });
                }
                hook.interceptor.detach();
            });
        }
        return watcher !== null;
    };

    this.sendInfos = function (reason, p, ctx, hook) {
        var tid;
        if (p === null && ctx === null) {
            tid = Process.id;
        } else {
            tid = Process.getCurrentThreadId();
        }

        var data = {
            "tid": tid,
            "reason": reason
        };

        if (reason === REASON_SET_INITIAL_CONTEXT) {
            data['arch'] = Process.arch;
            data['platform'] = Process.platform;
            data['java'] = Java.available;
            data['pid'] = Process.id;
            data['pointerSize'] = Process.pointerSize;
        } else if (reason === REASON_BREAKPOINT_NATIVE_ONLOAD) {
            data['module'] = hook.module;
            data['moduleBase'] = hook.moduleBase;
            data['moduleEntry'] = hook.moduleEntry;
        }

        var bt = null;
        const showDetails = isDefined(hook) && hook.showDetails;

        if (ctx !== null) {
            if (DEBUG) {
                _log('[' + tid + '] sendInfos - preparing infos for valid context');
            }

            data['context'] = ctx;
            var pc = this.procedure_call_register;
            if (typeof ctx[pc] !== 'undefined') {
                var symb = null;
                if (showDetails) {
                    try {
                        symb = DebugSymbol.fromAddress(ctx[pc]);
                    } catch (e) {
                        _log_err('_sendInfos', e);
                    }

                    if (DEBUG) {
                        _log('[' + tid + '] sendInfos - preparing native backtrace');
                    }

                    if (hook.showDetails) {
                        data['backtrace'] = { 'bt': api.nativeBacktrace(ctx), 'type': 'native' };
                    }
                }

                data['ptr'] = p;
                data['is_java'] = false;

                if (DEBUG) {
                    _log('[' + tid + '] sendInfos - preparing context registers');
                }

                var newCtx = {};

                for (var reg in ctx) {
                    var val = ctx[reg];
                    var isValidPtr = false;
                    if (DEBUG) {
                        _log('[' + tid + '] getting register information:', reg, val);
                    }
                    var ts = api.getAddressTs(val);
                    isValidPtr = ts[0] > 0;
                    newCtx[reg] = {
                        'value': val,
                        'isValidPointer': isValidPtr,
                        'telescope': ts
                    };
                    if (reg === pc) {
                        if (symb !== null) {
                            newCtx[reg]['symbol'] = symb;
                        }
                        try {
                            var inst = Instruction.parse(val);
                            newCtx[reg]['instruction'] = {
                                'size': inst.size,
                                'groups': inst.groups,
                                'thumb': inst.groups.indexOf('thumb') >= 0 ||
                                    inst.groups.indexOf('thumb2') >= 0
                            };
                        } catch (e) {
                            _log_err('_sendInfos', e);
                        }
                    }
                }

                data['context'] = newCtx;
            } else {
                // java hook
                data['is_java'] = true;
                data['ptr'] = p;
                if (DEBUG) {
                    _log('[' + tid + '] sendInfos - preparing java backtrace');
                }
                bt = { 'bt': api.javaBacktrace(), 'type': 'java' };
                data['backtrace'] = bt;
            }
        }

        if (DEBUG) {
            _log('[' + tid + '] sendInfos - dispatching infos');
        }

        loggedSend('set_context:::' + JSON.stringify(data));
    };

    this.stalk = function () {
        getDwarf().hitPreventRelease();

        const arch = Process.arch;
        const isArm64 = arch === 'arm64';

        if (!isArm64 && arch !== 'x64') {
            console.log('stalker is not supported on current arch: ' + arch);
            return null;
        }

        const tid = Process.getCurrentThreadId();

        var stalkerInfo = getDwarf().stalker_info[tid];
        if (!isDefined(stalkerInfo)) {
            const context = getDwarf().native_contexts[tid];
            if (!isDefined(context)) {
                console.log('cant start stalker outside a valid native context');
                return null;
            }

            stalkerInfo = new StalkerInfo(tid);
            getDwarf().stalker_info[tid] = stalkerInfo;

            const initialContextAddress = ptr(parseInt(context.pc));

            // prevent re-attach to hook if needed
            const hook = getDwarf().hooks[initialContextAddress];
            if (isDefined(hook)) {
                hook.interceptor = null;
                stalkerInfo.hookBackup = new Hook().clone(hook);
                delete getDwarf().hooks[initialContextAddress];
            }

            // this will maybe be replaced in the future
            // when we start stepping, the first basic block is copied into frida space and executed there
            // we need to calculate when it is executed somehow
            var retCount = 0;
            var arm64BlockCount = 0;
            var firstInstructionExec = false;
            var firstBlockCallout = false;
            var calloutHandled = false;

            if (DEBUG) {
                _log('[' + tid + '] stalk: '  + 'attaching stalker')
            }
            Stalker.follow(tid, {
                transform: function (iterator) {
                    var instruction;

                    if (DEBUG) {
                        _log('[' + tid + '] stalk: '  + 'transform begin')
                    }

                    while ((instruction = iterator.next()) !== null) {
                        iterator.keep();

                        if (instruction.groups.indexOf('jump') < 0 && instruction.groups.indexOf('call') < 0) {
                            stalkerInfo.lastBlockInstruction = {groups: instruction.groups, address: instruction.address};
                        } else {
                            stalkerInfo.lastCallJumpInstruction = {groups: instruction.groups, address: instruction.address};
                        }

                        if (!calloutHandled) {
                            if (retCount > 4) {
                                if (isArm64 && arm64BlockCount < 2) {
                                    continue;
                                }

                                if (!firstInstructionExec) {
                                    if (DEBUG) {
                                        _log('[' + tid + '] stalk: '  + 'executing first instruction',
                                            instruction.address.toString(), instruction.toString());
                                    }

                                    stalkerInfo.initialContextAddress = initialContextAddress.add(instruction.size);
                                    firstInstructionExec = true;
                                    continue;
                                }

                                if (DEBUG) {
                                    _log('[' + tid + '] stalk: '  + 'executing first basic block instructions',
                                        instruction.address.toString(), instruction.toString());
                                }

                                calloutHandled = true;
                                firstBlockCallout = true;
                                iterator.putCallout(getDwarf().stalkerCallout);
                            }

                            if (instruction.mnemonic === 'ret') {
                                retCount++;
                            }
                        } else {
                            if (DEBUG) {
                                _log('[' + tid + '] stalk: '  + 'executing instruction',
                                    instruction.address.toString(), instruction.toString());
                            }

                            iterator.putCallout(getDwarf().stalkerCallout);
                        }
                    }

                    if (DEBUG) {
                        _log('[' + tid + '] stalk: '  + 'transform done')
                    }

                    if (stalkerInfo.terminated) {
                        api._stopStep(stalkerInfo.tid);
                    }

                    if (retCount > 4 && isArm64) {
                        arm64BlockCount += 1;
                    }

                    if (firstBlockCallout) {
                        firstBlockCallout = false;
                    }
                }
            });
        }

        return stalkerInfo;
    };

    this.start = function () {
        api = new DwarfApi();
        fs = new DwarfFs();

        // register all api as global
        Object.getOwnPropertyNames(api).forEach(function (prop) {
            if (prop[0] !== '_') {
                global[prop] = api[prop];
            }
        });

        Process.setExceptionHandler(getDwarf().handleException);

        if (Process.platform === 'windows') {
            // break proc at main
            if (SPAWNED && BREAK_START) {
                var initialHook = Interceptor.attach(api.findExport('RtlUserThreadStart'), function (args) {
                    var hook = new Hook();
                    if (Process.arch === 'ia32') {
                        hook.nativePtr = this.context.eax;
                    } else if (Process.arch === 'x64') {
                        hook.nativePtr = this.context.rax;
                    }
                    hook.internalHook = true;
                    hook.debugSymbol = DebugSymbol.fromAddress(hook.nativePtr);
                    hook.interceptor = DwarfInterceptor.attach(hook.nativePtr, function () {
                        api.deleteHook(hook.nativePtr);
                    }, {
                        _internal: true
                    });
                    initialHook.detach();
                });
            }

            // windows native onload code
            var module = Process.findModuleByName('kernel32.dll');
            if (module !== null) {
                var symbols = module.enumerateExports();
                var loadliba_ptr = 0;
                var loadlibexa_ptr = 0;
                var loadlibw_ptr = 0;
                var loadlibexw_ptr = 0;

                for (var symbol in symbols) {
                    if (symbols[symbol].name.indexOf('LoadLibraryA') >= 0) {
                        loadliba_ptr = symbols[symbol].address;
                    } else if (symbols[symbol].name.indexOf('LoadLibraryW') >= 0) {
                        loadlibw_ptr = symbols[symbol].address;
                    } else if (symbols[symbol].name.indexOf('LoadLibraryExA') >= 0) {
                        loadlibexa_ptr = symbols[symbol].address;
                    } else if (symbols[symbol].name.indexOf('LoadLibraryExW') >= 0) {
                        loadlibexw_ptr = symbols[symbol].address;
                    }

                    if ((loadliba_ptr > 0) && (loadlibw_ptr > 0) && (loadlibexa_ptr > 0) && (loadlibexw_ptr > 0)) {
                        break;
                    }
                }
                if ((loadliba_ptr > 0) && (loadlibw_ptr > 0) && (loadlibexa_ptr > 0) && (loadlibexw_ptr > 0)) {
                    Interceptor.attach(loadliba_ptr, function (args) {
                        try {
                            var w = Memory.readAnsiString(args[0]);
                            getDwarf().breakModuleLoading.apply(this, [w]);
                        } catch (e) {
                            _log_err('Dwarf.start', e);
                        }
                    });
                    Interceptor.attach(loadlibexa_ptr, function (args) {
                        try {
                            var w = Memory.readAnsiString(args[0]);
                            getDwarf().breakModuleLoading.apply(this, [w]);
                        } catch (e) {
                            _log_err('Dwarf.start', e);
                        }
                    });
                    Interceptor.attach(loadlibw_ptr, function (args) {
                        try {
                            var w = Memory.readUtf16String(args[0]);
                            getDwarf().breakModuleLoading.apply(this, [w]);
                        } catch (e) {
                            _log_err('Dwarf.start', e);
                        }
                    });
                    Interceptor.attach(loadlibexw_ptr, function (args) {
                        try {
                            var w = Memory.readUtf16String(args[0]);
                            getDwarf().breakModuleLoading.apply(this, [w]);
                        } catch (e) {
                            _log_err('Dwarf.start', e);
                        }
                    });
                }
            }
        } else if (Java.available) {
            // create the java helper instance
            javaHelper = new JavaHelper();
            // initialize it
            javaHelper._initialize();

            // android native onload code
            if (javaHelper._sdk >= 23) {
                var module = Process.findModuleByName(Process.arch.indexOf('64') >= 0 ? 'linker64' : "linker");
                if (module !== null) {
                    var symb = module.enumerateSymbols();
                    var call_constructors = 0;

                    for (var sym in symb) {
                        if (symb[sym].name.indexOf("call_constructors") >= 0) {
                            call_constructors = symb[sym].address;
                            break;
                        }
                    }

                    if (call_constructors) {
                        function attach_call_constructors() {
                            var intr = wrappedInterceptor.attach(call_constructors, function (args) {
                                intr.detach();
                                try {
                                    getDwarf().breakModuleLoading.apply(this, [args[4].readUtf8String()]);
                                } catch (e) {}
                                attach_call_constructors();
                            });
                        }

                        attach_call_constructors();
                    }
                }
            } else {
                if (Process.arch === 'ia32') {
                    // this suck hard but it's the best way i can think
                    // working on latest nox emulator 5.1.1
                    var linkerRanges = Process.findModuleByName('linker').enumerateRanges('r-x');
                    for (var i = 0; i < linkerRanges.length; i++) {
                        var range = linkerRanges[i];
                        var res = Memory.scanSync(range.base, range.size, '89 FD C7 44 24 30 00 00 00 00');
                        if (res.length > 0) {
                            Interceptor.attach(res[0].address, function () {
                                if (this.context.ecx.toInt32() !== 0x8) {
                                    return;
                                }

                                try {
                                    var w = Memory.readCString(this.context.esi);
                                    getDwarf().breakModuleLoading.apply(this, [w]);
                                } catch (e) {
                                    _log_err('Dwarf.onLoad setup', e);
                                }
                            });
                            break;
                        }
                    }
                }
            }
        }
    };

    this.stalkerCallout = function(context) {
        const tid = Process.getCurrentThreadId();
        const stalkerInfo = getDwarf().stalker_info[tid];

        if (!isDefined(stalkerInfo) || stalkerInfo.terminated) {
            return;
        }

        var pc = context.pc;
        const insn = Instruction.parse(pc);

        if (DEBUG) {
            _log('[' + tid + '] stalkerCallout: ' + 'running callout', insn.address, insn.toString());
        }

        if (!stalkerInfo.didFistJumpOut) {
            pc = stalkerInfo.initialContextAddress;

            const lastInt = parseInt(stalkerInfo.lastContextAddress);
            if (lastInt > 0) {
                const pcInt = parseInt(context.pc);

                if (pcInt < lastInt || pcInt > lastInt + insn.size) {
                    pc = context.pc;
                    stalkerInfo.didFistJumpOut = true;
                }
            }
        }

        var shouldBreak = false;

        if (stalkerInfo.currentMode !== null) {
            if (typeof stalkerInfo.currentMode === 'function') {
                shouldBreak = false;

                const that = {
                    context: context,
                    instruction: insn,
                    stop: function () {
                        stalkerInfo.terminated = true;
                    }
                };

                stalkerInfo.currentMode.apply(that);
            } else if (stalkerInfo.lastContextAddress !== null &&
                stalkerInfo.lastCallJumpInstruction !== null) {
                if (DEBUG) {
                    _log('[' + tid + '] stalkerCallout: ' + 'using mode ->', stalkerInfo.currentMode);
                }
                // call and jumps doesn't receive callout
                const isAddressBeforeJumpOrCall = parseInt(context.pc) === parseInt(
                    stalkerInfo.lastBlockInstruction.address);

                if (isAddressBeforeJumpOrCall) {
                    if (stalkerInfo.currentMode === 'call') {
                        if (stalkerInfo.lastCallJumpInstruction.groups.indexOf('call') >= 0) {
                            shouldBreak = true;
                        }
                    } else if (stalkerInfo.currentMode === 'block') {
                        if (stalkerInfo.lastCallJumpInstruction.groups.indexOf('jump') >= 0) {
                            shouldBreak = true;
                        }
                    }
                }
            }
        } else {
            shouldBreak = true;
        }

        if (shouldBreak) {
            stalkerInfo.context = context;
            stalkerInfo.lastContextAddress = context.pc;

            const hook = new Hook();
            hook.nativePtr = pc;
            hook.internalHook = true;
            hook.showDetails = false;
            getDwarf().breakpoint(REASON_STEP, pc, stalkerInfo.context, hook, null);

            if (DEBUG) {
                _log('[' + tid + '] callOut: ' + 'post onHook');
            }
        }

        if (!stalkerInfo.didFistJumpOut) {
            stalkerInfo.initialContextAddress = stalkerInfo.initialContextAddress.add(insn.size);
        }
    };
}

function DwarfApi() {
    this._detach = function () {
        for (var h in getDwarf().hooks) {
            var hook = getDwarf().hooks[h];
            if (hook.interceptor !== null) {
                hook.interceptor.detach();
            }
        }
        Interceptor.detachAll();
        api.releaseFromJs(0)
        // wait all contexts to be released
    };

    this._internalMemoryScan = function (start, size, pattern) {
        if (size > 4096) {
            // scan in chunks of 4096
            var _start = parseInt(start);
            var end = _start + size;
            var result = [];
            var _break = false;
            while (true) {
                var s = 4096;
                if (_start + s > end) {
                    s = end - _start;
                    _break = true;
                }
                result = result.concat(Memory.scanSync(start, s, pattern));
                if (_break || result.length >= 100) {
                    break;
                }
                start = start.add(size);
                _start += s;
            }
            return result;
        } else {
            return Memory.scanSync(start, size, pattern);
        }
    };

    this._step = function (mode) {
        if (typeof mode === 'undefined') {
            mode = null;
        }

        const stalkerInfo = getDwarf().stalk();
        if (stalkerInfo !== null) {
            stalkerInfo.currentMode = mode;
            return true;
        }

        return false;
    };

    this._stopStep = function (tid) {
        const stalkerInfo = getDwarf().stalker_info[tid];
        if (isDefined(stalkerInfo)) {
            if (isDefined(stalkerInfo.hookBackup)) {
                if (DEBUG) {
                    _log('[' + tid + '] step: '  + 're-attaching hook backup at: ' +
                        stalkerInfo.hookBackup.nativePtr);
                }

                const hook = new Hook().clone(stalkerInfo.hookBackup);
                getDwarf().hooks[hook.nativePtr] = hook;
                DwarfInterceptor.attach(hook);
            }

            if (DEBUG) {
                _log('[' + tid + '] stopStep: '  + 'unfollowing tid');
            }

            Stalker.flush();
            Stalker.unfollow(tid);
            Stalker.garbageCollect();

            delete getDwarf().stalker_info[stalkerInfo.tid];
        }
    };

    this.addWatcher = function (pt, flags) {
        var range;
        pt = ptr(pt);
        // default '--?'
        if (typeof flags === 'undefined') {
            flags = (MEMORY_ACCESS_READ | MEMORY_ACCESS_WRITE);
        }

        if (Process.platform === 'windows') {
            if (typeof getDwarf().memory_watchers[pt] === 'undefined') {
                range = Process.findRangeByAddress(pt);
                if (range === null) {
                    return;
                }

                const watcher = new MemoryWatcher(pt, range.protection, flags);
                getDwarf().memory_watchers[pt] = watcher;
                getDwarf().memory_addresses.push({ 'base': pt, 'size': 1 });
                loggedSend('watcher_added:::' + pt + ':::' + flags + ':::' + JSON.stringify(watcher.debugSymbol));
            }
            MemoryAccessMonitor.enable(getDwarf().memory_addresses, { onAccess: getDwarf().onMemoryAccess });
            return;
        }

        if (typeof getDwarf().memory_watchers[pt] === 'undefined') {
            range = Process.findRangeByAddress(pt);
            if (range === null) {
                return;
            }

            const watcher = new MemoryWatcher(pt, range.protection, flags);
            getDwarf().memory_watchers[pt] = watcher;
            loggedSend('watcher_added:::' + pt + ':::' + flags + ':::' + JSON.stringify(watcher.debugSymbol));
        }
        getDwarf().memory_watchers[pt].watch();
    };

    this.breakpoint = function () {
        getDwarf().breakpoint();
    };

    this.deleteHook = function (key) {
        if (typeof key === 'number') {
            key = dethumbify(key);
        } else if (typeof key === 'string' && key.startsWith('0x')) {
            key = dethumbify(key);
        } else if (key.constructor.name === 'NativePointer') {
            key = dethumbify(key);
        }

        var hook = getDwarf().hooks[key];

        if (typeof hook === 'undefined') {
            if (typeof getDwarf().nativeOnLoads[key] !== 'undefined') {
                loggedSend('hook_deleted:::native_on_load:::' + key);
                delete getDwarf().nativeOnLoads[key];
            } else if (typeof getDwarf().javaOnLoads[key] !== 'undefined') {
                loggedSend('hook_deleted:::java_on_load:::' + key);
                delete getDwarf().javaOnLoads[key];
            } else {
                _log('undefined hook with key: ' + key);
            }
            return;
        }

        if (hook.interceptor !== null) {
            hook.interceptor.detach();
            delete getDwarf().hooks[key];
            loggedSend('hook_deleted:::native:::' + key);
        } else if (hook.javaClassMethod !== null) {
            api.hookJavaConstructor(hook.javaClassMethod, null, true);
            api.hookJavaMethod(hook.javaClassMethod, null, true);
            delete getDwarf().hooks[key];
            loggedSend('hook_deleted:::java:::' + key);
        }
    };

    this.enumerateExports = function (module) {
        if (typeof module !== 'object') {
            module = api.findModule(module);
        }
        if (module !== null) {
            return module.enumerateExports();
        }
        return {};
    };

    this.enumerateImports = function (module) {
        if (typeof module !== 'object') {
            module = api.findModule(module);
        }
        if (module !== null) {
            return module.enumerateImports();
        }
        return {};
    };

    this.enumerateJavaClasses = function (useCache) {
        useCache = useCache | false;

        if (useCache && javaHelper !== null && javaHelper._java_classes.length > 0) {
            loggedSend('enumerate_java_classes_start:::');
            for (var i = 0; i < javaHelper._java_classes.length; i++) {
                send('enumerate_java_classes_match:::' + javaHelper._java_classes[i]);
            }
            send('enumerate_java_classes_complete:::');
        } else {
            // invalidate cache
            if (javaHelper !== null) {
                javaHelper._java_classes = [];
            }

            Java.performNow(function () {
                loggedSend('enumerate_java_classes_start:::');
                try {
                    Java.enumerateLoadedClasses({
                        onMatch: function (className) {
                            if (javaHelper !== null) {
                                javaHelper._java_classes.push(className);
                            }
                            send('enumerate_java_classes_match:::' + className);
                        },
                        onComplete: function () {
                            send('enumerate_java_classes_complete:::');
                        }
                    });
                } catch (e) {
                    _log_err('enumerateJavaClasses', e);
                    loggedSend('enumerate_java_classes_complete:::');
                }
            });
        }
    };

    this.enumerateJavaMethods = function (className) {
        if (Java.available) {
            Java.performNow(function () {
                // 0xdea code -> https://github.com/0xdea/frida-scripts/blob/master/raptor_frida_android_trace.js
                var clazz = Java.use(className);
                var methods = clazz.class.getDeclaredMethods();
                clazz.$dispose();

                var parsedMethods = [];
                methods.forEach(function (method) {
                    parsedMethods.push(method.toString().replace(className + ".",
                        "TOKEN").match(/\sTOKEN(.*)\(/)[1]);
                });
                var result = uniqueBy(parsedMethods);
                loggedSend('enumerate_java_methods_complete:::' + className + ':::' +
                    JSON.stringify(result));
            });
        }
    };

    this.enumerateModules = function () {
        var modules = Process.enumerateModules();
        for (var i = 0; i < modules.length; i++) {
            // skip ntdll on windoof (access_violation)
            if (Process.platform === 'windows') {
                if (modules[i].name === 'ntdll.dll') {
                    continue;
                }
            } else if (Process.platform === 'linux') {
                if (javaHelper !== null) {
                    if (javaHelper._sdk <= 23) {
                        if (modules[i].name === 'app_process') {
                            continue;
                        }
                    }
                }
            }

            modules[i] = api.enumerateModuleInfo(modules[i]);
        }
        return modules;
    };

    this.enumerateModuleInfo = function (m) {
        try {
            m.imports = api.enumerateImports(m);
            m.exports = api.enumerateExports(m);
            m.symbols = api.enumerateSymbols(m);
        } catch(e) {}

        m.entry = null;
        var header = m.base.readByteArray(4);
        if (header[0] !== 0x7f && header[1] !== 0x45 && header[2] !== 0x4c && header[3] !== 0x46) {
            // Elf
            m.entry = m.base.add(24).readPointer();
        }

        return m;
    };

    this.enumerateRanges = function () {
        return Process.enumerateRanges('---');
    };

    this.enumerateSymbols = function (module) {
        if (typeof module !== 'object') {
            module = api.findModule(module);
        }
        if (module !== null) {
            return module.enumerateSymbols();
        }
        return {};
    };

    this.evaluate = function (w, nolog) {
        if (typeof nolog !== 'boolean') {
            nolog = false;
        }
        try {
            var Interceptor = DwarfInterceptor;
            var Thread = DwarfThread;
            var res = eval(w);
            if (!nolog && typeof res !== 'undefined') {
                console.log(res);
            }
            return res;
        } catch (e) {
            _log_err('evaluate', e);
            return '';
        }
    };

    this.evaluateFunction = function (w) {
        try {
            var fn = new Function('var Interceptor = DwarfInterceptor; var Thread = DwarfThread;\n' + w);
            return fn.apply(this, []);
        } catch (e) {
            _log_err('evaluateFunction', e);
            return '';
        }
    };

    this.evaluatePtr = function (w) {
        try {
            return ptr(eval(w));
        } catch (e) {
            _log_err('evaluatePtr', e);
            return ptr(0);
        }
    };

    this.findExport = function (name, module) {
        if (typeof module === 'undefined') {
            module = null;
        }
        return Module.findExportByName(module, name);
    };

    this.findModule = function (module) {
        var _module;
        if (isString(module) && module.substring(0, 2) !== '0x') {
            _module = Process.findModuleByName(module);
            if (isDefined(_module)) {
                return _module;
            } else {
                // do wildcard search
                if (module.indexOf('*') !== -1) {
                    var modules = Process.enumerateModules();
                    var searchName = module.toLowerCase();
                    searchName = searchName.split('*')[0];
                    for (var i = 0; i < modules.length; i++) {
                        // remove non matching
                        if (modules[i].name.toLowerCase().indexOf(searchName) === -1) {
                            modules.splice(i, 1);
                            i--;
                        }
                    }
                    if (modules.length === 1) {
                        return modules[0];
                    } else {
                        return JSON.stringify(modules);
                    }
                }
            }
        } else {
            _module = Process.findModuleByAddress(ptr(module));
            if (!isDefined(_module)) {
                _module = {};
            }
            return _module;
        }
        return {};
    };

    this.findSymbol = function (pattern) {
        return DebugSymbol.findFunctionsMatching(pattern);
    };

    this.getAddressTs = function (p) {
        var _ptr = ptr(p);
        var _range = Process.findRangeByAddress(_ptr);
        if (isDefined(_range)) {
            if (_range.protection.indexOf('r') !== -1) {
                try {
                    var s = api.readString(_ptr);
                    if (s !== "") {
                        return [0, s];
                    }
                } catch (e) { }
                try {
                    var ptrVal = Memory.readPointer(_ptr);
                    return [1, ptrVal];
                } catch(e) {
                }
                return [2, p];
            }
        }
        return [-1, p];
    };


    this.getDebugSymbols = function (ptrs) {
        var symbols = [];
        if(isDefined(ptrs)) {
            try {
                ptrs = JSON.parse(ptrs);
            } catch(e) {
                _log_err('getDebugSymbols', e);
                return symbols;
            }
            for(var i = 0; i < ptrs.length; i++) {
                symbols.push(api.getSymbolByAddress(ptrs[i]));
            }
        }
        return symbols;
    };

    this.getInstruction = function (address) {
        try {
            var instruction = Instruction.parse(ptr(address));
            return JSON.stringify({
                'string': instruction.toString()
            });
        } catch (e) {
            _log_err('getInstruction', e);
        }
        return null;
    };

    this.getRange = function (pt) {
        try {
            pt = ptr(pt);
            if (pt === null || parseInt(pt) === 0) {
                return [];
            }
            var ret = Process.findRangeByAddress(pt);
            if (ret == null) {
                return [];
            }
            return ret;
        } catch (e) {
            _log_err('getRange', e);
            return [];
        }
    };

    this.getSymbolByAddress = function (pt) {
        try {
            pt = ptr(pt);
            return DebugSymbol.fromAddress(pt);
        } catch (e) {
            _log_err('getSymbolByAddress', e);
            return {};
        }
    };

    this.hookAllJavaMethods = function (className) {
        if (!Java.available) {
            return false;
        }

        Java.performNow(function () {
            var clazz = Java.use(className);
            var methods = clazz.class.getDeclaredMethods();

            var parsedMethods = [];
            methods.forEach(function (method) {
                parsedMethods.push(method.toString().replace(className + ".",
                    "TOKEN").match(/\sTOKEN(.*)\(/)[1]);
            });
            var result = uniqueBy(parsedMethods);
            result.forEach(function (method) {
                api.hookJavaMethod(className + '.' + method);
            });
            clazz.$dispose();
        });
    };

    this.hookJava = function (what, impl) {
        if (isDefined(what)) {
            api.hookJavaMethod(what, impl);
        }
    };

    this.hookJavaConstructor = function (className, implementation, restore) {
        if (!Java.available) {
            return;
        }
        if(isDefined(className)) {
            restore = typeof restore === 'undefined' ? false : restore;
            javaHelper.hook(className, '$init', true, implementation, restore, false);
        }
    };

    this.hookJavaMethod = function (targetClassMethod, implementation, restore) {
        if (!Java.available) {
            return false;
        }
        if(isDefined(targetClassMethod)) {
            restore = typeof restore === 'undefined' ? false : restore;
            var delim = targetClassMethod.lastIndexOf(".");
            if (delim === -1) return;

            var targetClass = targetClassMethod.slice(0, delim);
            var targetMethod = targetClassMethod.slice(delim + 1, targetClassMethod.length);
            javaHelper.hook(targetClass, targetMethod, true, implementation, restore, false);
        }
    };

    this.hookJavaOnLoad = function (clazz, logic) {
        if (isDefined(clazz)) {
            if (getDwarf().javaOnLoads[clazz] === null || typeof (getDwarf().javaOnLoads[clazz]) === 'undefined') {
                var hook = new Hook();
                hook.onLoadHook = true;
                hook.javaClassMethod = clazz;
                if (typeof logic !== 'undefined') {
                    hook.logic = logic;
                }
                getDwarf().javaOnLoads[clazz] = hook;
                loggedSend('hook_java_on_load_callback:::' + clazz);
            }
        }
    };

    this.hookNative = function (what, logic, options) {
        if (isDefined(what)) {
            DwarfInterceptor.attach(what, logic, options);
        }
    };

    this.hookNativeOnLoad = function (moduleName, logic) {
        if (isString(moduleName)) {
            if (getDwarf().nativeOnLoads[moduleName] === null ||
                typeof (getDwarf().nativeOnLoads[moduleName]) === 'undefined') {
                var hook = new Hook();
                hook.onLoadHook = true;
                hook.module = moduleName;
                if (typeof logic !== 'undefined') {
                    hook.logic = logic;
                }
                getDwarf().nativeOnLoads[moduleName] = hook;
                loggedSend('hook_native_on_load_callback:::' + moduleName);
            }
        }
    };

    this.injectBlob = function (name, blob) {
        // arm syscall memfd_create
        var sys_num = 385;
        if (Process.arch === 'ia32') {
            sys_num = 356;
        } else if (Process.arch === 'x64') {
            sys_num = 319;
        }

        var syscall_ptr = api.findExport('syscall');
        var write_ptr = api.findExport('write');
        var dlopen_ptr = api.findExport('dlopen');

        if (syscall_ptr !== null && !syscall_ptr.isNull()) {
            var syscall = new NativeFunction(syscall_ptr, 'int', ['int', 'pointer', 'int']);
            if (write_ptr !== null && !write_ptr.isNull()) {
                var write = new NativeFunction(write_ptr, 'int', ['int', 'pointer', 'int']);
                if (dlopen_ptr !== null && !dlopen_ptr.isNull()) {
                    var dlopen = new NativeFunction(dlopen_ptr, 'int', ['pointer', 'int']);

                    var m = fs.allocateRw(128);
                    Memory.writeUtf8String(m, name);
                    var fd = syscall(sys_num, m, 0);
                    if (fd > 0) {
                        blob = hex2a(blob);
                        var blob_space = Memory.alloc(blob.length);
                        Memory.protect(blob_space, blob.length, 'rwx');
                        Memory.writeByteArray(blob_space, blob);
                        write(fd, blob_space, blob.length);
                        Memory.writeUtf8String(m, '/proc/' + Process.id + '/fd/' + fd);
                        return dlopen(m, 1);
                    } else {
                        return -4;
                    }
                } else {
                    return -3;
                }
            } else {
                return -2;
            }
        } else {
            return -1;
        }
    };

    this.isAddressWatched = function (pt) {
        var watcher = getDwarf().memory_watchers[ptr(pt)];
        return isDefined(watcher);
    };

    this.isPrintable = function (char) {
        try {
            var isprint_ptr = api.findExport('isprint');
            if (isDefined(isprint_ptr)) {
                var isprint_fn = new NativeFunction(isprint_ptr, 'int', ['int']);
                if (isDefined(isprint_fn)) {
                    return isprint_fn(char);
                }
            }
            else {
                if ((char > 31) && (char < 127)) {
                    return true;
                }
            }
            return false;
        } catch (e) {
            _log_err('isPrintable', e);
            return false;
        }
    };

    this.isValidPointer = function (pt) {
        var _ptr = ptr(pt);
        var _range = Process.findRangeByAddress(_ptr);
        if (isDefined(_range)) {
            if (_range.protection.indexOf('r') !== -1) {
                try {
                    Memory.readPointer(_ptr);
                    return true;
                } catch (e) { }
            }
        }
        return false;
    };

    this.javaBacktrace = function () {
        return Java.use("android.util.Log")
            .getStackTraceString(Java.use("java.lang.Exception").$new());
    };

    this.javaExplorer = function (what) {
        if (typeof this['hook_context'] === 'undefined') {
            console.log('Explorer outside context scope');
            return null;
        } else {
            var handle;
            if (typeof what === 'number') {
                if (what >= 0) {
                    var hc = this['hook_context'];
                    var arg = hc['context'][what];
                    if (arg === null || typeof arg['handle'] === 'undefined') {
                        return null;
                    }
                    handle = arg['handle'];
                } else {
                    handle = this['hook_context']['java_handle'];
                }
            } else if (typeof what === 'object') {
                if (typeof what['handle_class'] !== 'undefined') {
                    var cl = Java.use(what['handle_class']);
                    handle = what['handle'];
                    if (typeof handle === 'string') {
                        handle = getDwarf().java_handlers[handle];
                        if (typeof handle === 'undefined') {
                            return null;
                        }
                    } else if (typeof handle === 'object') {
                        try {
                            handle = Java.cast(ptr(handle['$handle']), cl);
                        } catch (e) {
                            _log_err('javaExplorer', e + ' | ' + handle['$handle']);
                            return null;
                        }
                    } else {
                        try {
                            handle = Java.cast(ptr(handle), cl);
                        } catch (e) {
                            _log_err('javaExplorer', e + ' | ' + handle);
                            return null;
                        }
                    }
                    cl.$dispose();
                } else {
                    handle = what;
                }
            } else {
                console.log('Explorer handle not found');
                return {};
            }
            if (handle === null || typeof handle === 'undefined') {
                console.log('Explorer handle null');
                return {};
            }
            var ol;
            try {
                ol = Object.getOwnPropertyNames(handle.__proto__);
            } catch (e) {
                _log_err('javaExplorer-1', e);
                return null;
            }
            var clazz = '';
            if (typeof handle['$className'] !== 'undefined') {
                clazz = handle['$className'];
            }
            var ret = {
                'class': clazz,
                'data': {}
            };
            for (var o in ol) {
                var name = ol[o];
                try {
                    var t = typeof handle[name];
                    var value = '';
                    var overloads = [];
                    var sub_handle = null;
                    var sub_handle_class = '';

                    if (t === 'function') {
                        if (typeof handle[name].overloads !== 'undefined') {
                            var overloadCount = handle[name].overloads.length;
                            if (overloadCount > 0) {
                                for (var i in handle[name].overloads) {
                                    overloads.push({
                                        'args': handle[name].overloads[i].argumentTypes,
                                        'return': handle[name].overloads[i].returnType
                                    });
                                }
                            }
                        }
                    } else if (t === 'object') {
                        if (handle[name] !== null) {
                            sub_handle_class = handle[name]['$className'];
                        }

                        if (typeof handle[name]['$handle'] !== 'undefined' && handle[name]['$handle'] !== null) {
                            value = handle[name]['$handle'];
                            sub_handle = handle[name]['$handle'];
                        } else {
                            if (handle[name] !== null && handle[name]['value'] !== null) {
                                sub_handle_class = handle[name]['value']['$className'];
                            }

                            if (handle[name] !== null && handle[name]['value'] !== null &&
                                typeof handle[name]['value'] === 'object') {
                                if (typeof handle[name]['fieldReturnType'] !== 'undefined') {
                                    sub_handle = handle[name]['value'];
                                    if (typeof sub_handle['$handle'] !== 'undefined') {
                                        var pt = sub_handle['$handle'];
                                        getDwarf().java_handlers[pt] = sub_handle;
                                        sub_handle = pt;
                                        value = handle[name]['fieldReturnType']['className'];
                                        sub_handle_class = value;
                                    } else {
                                        t = handle[name]['fieldReturnType']['type'];
                                        sub_handle_class = handle[name]['fieldReturnType']['className'];

                                        if (handle[name]['fieldReturnType']['type'] !== 'pointer') {
                                            value = sub_handle_class;
                                        } else {
                                            if (handle[name]['value'] !== null) {
                                                value = handle[name]['value'].toString();
                                                t = typeof (value);
                                            }
                                        }
                                    }
                                } else if (handle[name]['value'] !== null) {
                                    value = handle[name]['value'].toString();
                                    t = typeof (value);
                                }
                            } else if (handle[name]['value'] !== null) {
                                t = typeof (handle[name]['value']);
                                value = handle[name]['value'].toString();
                            }
                        }
                    } else {
                        value = handle[name];
                    }

                    ret['data'][name] = {
                        'value': value,
                        'handle': sub_handle,
                        'handle_class': sub_handle_class,
                        'type': t,
                        'overloads': overloads
                    };
                } catch (e) {
                    _log_err('javaExplorer-2', e);
                }
            }
            return ret;
        }
    };

    this.log = function (what) {
        if(isDefined(what)) {
            loggedSend('log:::' + what);
        }
    };

    this.nativeBacktrace = function (ctx) {
        return Thread.backtrace(ctx, Backtracer.ACCURATE)
            .map(DebugSymbol.fromAddress);
    };

    this.memoryScan = function (start, size, pattern) {
        var result = [];
        try {
            result = api._internalMemoryScan(ptr(start), size, pattern);
        } catch (e) {
            _log_err('memoryScan', e);
        }
        loggedSend('memoryscan_result:::' + JSON.stringify(result));
    };

    this.memoryScanList = function (ranges, pattern) {
        ranges = JSON.parse(ranges);
        var result = [];
        for (var i = 0; i < ranges.length; i++) {
            try {
                result = result.concat(api._internalMemoryScan(ptr(ranges[i]['start']), ranges[i]['size'], pattern));
            } catch (e) {
                _log_err('memoryScanList', e);
            }
            if (result.length >= 100) {
                break;
            }
        }
        loggedSend('memoryscan_result:::' + JSON.stringify(result));
    };

    this.readString = function (pt, l) {
        try {
            pt = ptr(pt);
            var fstring = "";
            var length = -1;
            if (isNumber(l)) {
                length = l;
            }
            var range = Process.findRangeByAddress(pt);
            if (!isDefined(range)) {
                return "";
            }
            if (isString(range.protection) && range.protection.indexOf('r') === -1) {
                //Access violation
                return "";
            }
            var _np = new NativePointer(pt);
            if (!isDefined(_np)) {
                return "";
            }
            if (Process.platform === 'windows') {
                fstring = _np.readAnsiString(length);
            }
            if (isString(fstring) && (fstring.length === 0)) {
                fstring = _np.readCString(length);
            }
            if (isString(fstring) && (fstring.length === 0)) {
                fstring = _np.readUtf8String(length);
            }
            if (isString(fstring) && fstring.length) {
                for (var i = 0; i < fstring.length; i++) {
                    if (!api.isPrintable(fstring.charCodeAt(i))) {
                        fstring = null;
                        break;
                    }
                }
            }
            if (fstring !== null && isString(fstring) && fstring.length) {
                return fstring;
            }
            else {
                return "";
            }
        } catch (e) {
            _log_err('readString', e);
            return "";
        }
    };

    this.readBytes = function (pt, l) {
        try {
            pt = ptr(pt);
            return pt.readByteArray(l);
        } catch (e) {
            _log_err('readBytes', e);
            return [];
        }
    };

    this.readPointer = function (pt) {
        try {
            return Memory.readPointer(ptr(pt));
        } catch (e) {
            _log_err('readPointer', e);
            return ptr(0x0)
        }
    };

    this.releaseFromJs = function (tid) {
        send('release_js:::' + tid);
    };

    this.removeWatcher = function (pt) {
        pt = ptr(pt);
        var watcher = getDwarf().memory_watchers[pt];
        if (typeof watcher !== 'undefined') {
            watcher.restore();
            if (Process.platform === 'windows') {
                MemoryAccessMonitor.disable();
                getDwarf().memory_addresses = getDwarf().memory_addresses.filter(function (value, index, arr) {
                    return parseInt(value.base, 16) !== pt;
                });
            }
            delete getDwarf().memory_watchers[pt];
            loggedSend('watcher_removed:::' + pt);
            return true;
        }
        return false;
    };

    this.restart = function () {
        if (Java.available) {
            Java.performNow(function () {
                var Intent = Java.use('android.content.Intent');

                var ctx = javaHelper.getApplicationContext();
                var intent = ctx.getPackageManager().getLaunchIntentForPackage(ctx.getPackageName());
                intent.addFlags(Intent.FLAG_ACTIVITY_CLEAR_TOP['value']);
                intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK['value']);
                intent.addFlags(Intent.FLAG_ACTIVITY_CLEAR_TASK['value']);
                ctx.startActivity(intent);
            });
        }
    };

    this.resume = function () {
        if (!getDwarf().proc_resumed) {
            getDwarf().proc_resumed = true;
            loggedSend('resume:::0');
        } else {
            console.log('Error: Process already resumed');
        }
    };

    this.setData = function (key, data) {
        if (typeof key !== 'string' && key.length < 1) {
            return;
        }

        if (data.constructor.name === 'ArrayBuffer') {
            loggedSend('set_data:::' + key, data)
        } else {
            if (typeof data === 'object') {
                data = JSON.stringify(data, null, 4);
            }
            loggedSend('set_data:::' + key + ':::' + data)
        }
    };

    this.setHookCondition = function (pt, w) {
        try {
            var hook = null;
            try {
                hook = getDwarf().hooks[dethumbify(pt)];
            } catch (e) {
                _log_err('setHookCondition', e);
            }

            if (typeof hook === 'undefined' || hook === null) {
                hook = getDwarf().nativeOnLoads[pt];
            }

            hook.condition = w;
            return true;
        } catch (e) {
            _log_err('setHookCondition', e);
            return false;
        }
    };

    this.setHookLogic = function (pt, w) {
        try {
            var hook = null;
            try {
                hook = getDwarf().hooks[dethumbify(pt)];
            } catch (e) {
                _log_err('setHookLogic', e);
            }

            if (typeof hook === 'undefined' || hook === null) {
                hook = getDwarf().nativeOnLoads[pt];
            }
            if (typeof hook === 'undefined' || hook === null) {
                return false;
            }
            if (w.startsWith('{')) {
                w = '(' + w + ')';
                w = eval(w);
            }
            hook.logic = w;
            return true;
        } catch (e) {
            _log_err('setHookLogic', e);
            return false;
        }
    };

    this.startJavaTracer = function (classes, callback) {
        if (javaHelper !== null) {
            return javaHelper.startTrace(classes, callback);
        }
        return false;
    };

    this.startNativeTracer = function (callback) {
        const stalkerInfo = getDwarf().stalk();
        if (stalkerInfo !== null) {
            stalkerInfo.currentMode = callback;
            return true;
        }

        return false;
    };

    this.stopJavaTracer = function () {
        if (javaHelper !== null) {
            return javaHelper.stopTrace();
        }
        return false;
    };

    this.updateModules = function () {
        var modules = api.enumerateModules();
        loggedSend('update_modules:::' + Process.getCurrentThreadId() + ':::' + JSON.stringify(modules));
    };

    this.updateRanges = function () {
        try {
            loggedSend('update_ranges:::' + Process.getCurrentThreadId() + ':::' +
                JSON.stringify(Process.enumerateRanges('---')))
        } catch (e) {
            _log_err('updateRanges', e);
        }
    };

    this.updateSearchableRanges = function () {
        try {
            loggedSend('update_searchable_ranges:::' + Process.getCurrentThreadId() + ':::' +
                JSON.stringify(Process.enumerateRanges('r--')))
        } catch (e) {
            _log_err('updateSearchableRanges', e);
        }
    };

    this.writeBytes = function (pt, what) {
        try {
            pt = ptr(pt);
            if (typeof what === 'string') {
                api.writeUtf8(pt, hex2a(what));
            } else {
                Memory.writeByteArray(pt, what);
            }
            return true;
        } catch (e) {
            _log_err('writeBytes', e);
            return false;
        }
    };

    this.writeUtf8 = function (pt, str) {
        try {
            pt = ptr(pt);
            Memory.writeUtf8String(pt, str);
            return true;
        } catch (e) {
            _log_err('writeUtf8', e);
            return false;
        }
    };

    this.parseElf = function (path) {
        try {
            return new ELF_File(path);
        } catch (e) {
            _log_err('parseElf', e.toString());
            return {};
        }
    };

    this.getInitArrayPtrs = function (path) {
        if (!isString(path)) {
            _log_err('invalid argument');
            return {};
        }
        var elffile = new ELF_File(path);
        if (isDefined(elffile) && isDefined(elffile.sectionheaders)) {
            var base = parseInt(Process.findModuleByName(path.substring(path.lastIndexOf('/') + 1))['base'], 16);
            if (isDefined(base) && isDefined(elffile.sectionheaders) && elffile.sectionheaders.length) {
                for (var i = 0; i < elffile.sectionheaders.length; i++) {
                    if (elffile.sectionheaders[i].name === '.init_array') {
                        if (isDefined(elffile.sectionheaders[i].data) && elffile.sectionheaders[i].data.length) {
                            return JSON.stringify(elffile.sectionheaders[i].data);
                        }
                    }
                }
            }
        }
        return {};
    }
}

function DwarfFs() {
    var p = api.findExport('fclose');
    if (p !== null && !p.isNull()) {
        this.fclose = new NativeFunction(p, 'int', ['pointer']);
    }
    p = api.findExport('fcntl');
    if (p !== null && !p.isNull()) {
        this.fcntl = new NativeFunction(p, 'int', ['int', 'int', 'int']);
    }
    p = api.findExport('fgets');
    if (p !== null && !p.isNull()) {
        this.fgets = new NativeFunction(p, 'int', ['pointer', 'int', 'pointer']);
    }
    p = api.findExport('fileno');
    if (p !== null && !p.isNull()) {
        this.fileno = new NativeFunction(p, 'int', ['pointer']);
    }
    p = api.findExport('fseek');
    if (p !== null && !p.isNull()) {
        this.fseek = new NativeFunction(p, 'int', ['pointer', 'int', 'int']);
    }
    p = api.findExport('fread');
    if (p !== null && !p.isNull()) {
        this.fread = new NativeFunction(p, 'uint32', ['pointer', 'uint32', 'uint32', 'pointer']);
    }
    p = api.findExport('fputs');
    if (p !== null && !p.isNull()) {
        this.fputs = new NativeFunction(p, 'int', ['pointer', 'pointer']);
    }
    p = api.findExport('getline');
    if (p !== null && !p.isNull()) {
        this.getline = new NativeFunction(p, 'int', ['pointer', 'pointer', 'pointer']);
    }
    p = api.findExport('pclose');
    if (p !== null && !p.isNull()) {
        this.pclose = new NativeFunction(p, 'int', ['pointer']);
    }
    p = api.findExport('fopen');
    if (p !== null && !p.isNull()) {
        this._fopen = new NativeFunction(p, 'pointer', ['pointer', 'pointer']);
    }
    p = api.findExport('popen');
    if (p !== null && !p.isNull()) {
        this._popen = new NativeFunction(p, 'pointer', ['pointer', 'pointer']);
    }

    this.allocateRw = function (size) {
        var pt = Memory.alloc(size);
        Memory.protect(pt, size, 'rw-');
        return pt;
    };

    this.allocateString = function (what) {
        return Memory.allocUtf8String(what);
    };

    this.fopen = function (filePath, perm) {
        var file_path_ptr = Memory.allocUtf8String(filePath);
        var p = Memory.allocUtf8String(perm);
        return this._fopen(file_path_ptr, p);
    };

    this.popen = function (filePath, perm) {
        var file_path_ptr = Memory.allocUtf8String(filePath);
        var p = Memory.allocUtf8String(perm);
        return this._popen(file_path_ptr, p);
    };

    this.readStringFromFile = function (filePath) {
        var fp = this.fopen(filePath, 'r');
        var ret = this.readStringFromFp(fp);
        this.fclose(fp);
        return ret;
    };

    this.readStringFromFp = function (fp) {
        var ret = "";
        if (fp !== null) {
            var buf = this.allocateRw(1024);
            while (ptr(this.fgets(buf, 1024, fp)) > ptr(0)) {
                ret += Memory.readUtf8String(buf);
            }
            return ret;
        }
        return ret;
    };

    this.writeStringToFile = function (filePath, content, append) {
        // use frida api
        if (typeof append === 'undefined') {
            append = false;
        }
        var f = new File(filePath, (append ? 'wa' : 'w'));
        f.write(content);
        f.flush();
        f.close();
    };
}

function Hook() {
    this.internalHook = false;
    this.onLoadHook = false;

    this.nativePtr = null;
    this.debugSymbol = null;

    this.javaClassMethod = null;

    this.module = '';
    this.moduleBase = 0x0;
    this.moduleEntry = 0x0;

    this.condition = null;
    this.logic = null;

    this.interceptor = null;
    this.interceptorArgs = null;

    this.javaOverloads = {};
    this.bytes = [];

    this.showDetails = true;

    this.options = {};

    this.clone = function (hook) {
        this.internalHook = hook.internalHook;
        this.onLoadHook = hook.onLoadHook;

        this.nativePtr = hook.nativePtr;
        this.debugSymbol = hook.debugSymbol;

        this.javaClassMethod = hook.javaClassMethod;

        this.module = hook.module;
        this.moduleBase = hook.moduleBase;
        this.moduleEntry = hook.moduleEntry;

        this.condition = hook.condition;
        this.logic = hook.logic;

        this.javaOverloads = hook.javaOverloads;

        this.showDetails = hook.showDetails;

        this.options = hook.options;

        return this;
    }
}

function HookApi(api_funct, args) {
    this.api_funct = api_funct;
    this.args = args;

    this.result = null;
    this.consumed = false;
}

function HookContext(tid) {
    this.tid = tid;
    this.context = null;
    this.java_handle = null;

    this.api_queue = [];
    this.prevent_sleep = false;
}

function JavaHelper() {
    this.available = Java.available;
    this._java_classes = [];
    this._traced_classes = [];
    this._tracing = false;
    this._sdk = 0;

    this._apply_tracer_implementations = function (attach, callback) {
        Java.performNow(function () {
            javaHelper._traced_classes.forEach(function (className) {
                try {
                    var clazz = Java.use(className);

                    // check if classMethod is hooked. If so, tracing is handled in the hook callback
                    var classMethod = className + '.$init';
                    if (typeof getDwarf().hooks[classMethod] === 'undefined') {
                        var overloadCount = clazz["$init"].overloads.length;
                        if (overloadCount > 0) {
                            for (var i = 0; i < overloadCount; i++) {
                                if (attach) {
                                    clazz["$init"].overloads[i].implementation =
                                        javaHelper.traceImplementation(callback, className, '$init');
                                } else {
                                    clazz["$init"].overloads[i].implementation = null;
                                }
                            }
                        }
                    }

                    var methods = clazz.class.getDeclaredMethods();
                    var parsedMethods = [];
                    methods.forEach(function (method) {
                        parsedMethods.push(method.toString().replace(className + ".",
                            "TOKEN").match(/\sTOKEN(.*)\(/)[1]);
                    });
                    methods = uniqueBy(parsedMethods);
                    methods.forEach(function (method) {
                        // same as ctor, check if method is hooked
                        // check if classMethod is hooked. If so, tracing is handled in the hook callback
                        var classMethod = className + '.' + method;
                        if (typeof getDwarf().hooks[classMethod] === 'undefined') {
                            var overloadCount = clazz[method].overloads.length;
                            if (overloadCount > 0) {
                                for (var i = 0; i < overloadCount; i++) {
                                    if (attach) {
                                        clazz[method].overloads[i].implementation =
                                            javaHelper.traceImplementation(callback, className, method);
                                    } else {
                                        clazz[method].overloads[i].implementation = null;
                                    }
                                }
                            }
                        }
                    });

                    clazz.$dispose();
                } catch (e) {
                    _log_err('JavaHelper.startTrace', e);
                }
            });
        });
    };

    this._hook_in_jvm = function (className, method, shouldBreak, implementation, restore, internal) {
        var handler = null;

        internal = internal || false;

        try {
            handler = Java.use(className);
        } catch (err) {
            try {
                className = className + '.' + method;
                method = '$init';
                handler = Java.use(className);
            } catch (err) { }

            _log_err('JavaHelper.hook', err);
            if (handler === null) {
                return;
            }
        }

        try {
            if (handler == null || typeof handler[method] === 'undefined') {
                return;
            }
        } catch (e) {
            // catching here not supported overload error from frida
            _log_err('JavaHelper.hook', e);
            return;
        }

        var overloadCount = handler[method].overloads.length;
        var classMethod = className + '.' + method;

        if (overloadCount > 0) {
            var hook;
            if (!restore) {
                if (!internal) {
                    loggedSend('hook_java_callback:::' + classMethod);
                }
                hook = new Hook();
                hook.javaClassMethod = classMethod;
                hook.javaOverloads = [];
                hook.internalHook = internal;
                getDwarf().hooks[classMethod] = hook;
            }

            for (var i = 0; i < overloadCount; i++) {
                var impl = null;
                if (!restore) {
                    var mArgs = handler[method].overloads[i].argumentTypes;
                    hook.javaOverloads[mArgs.length] = mArgs;
                    impl = javaHelper.hookImplementation(className, method, hook, shouldBreak, implementation,
                        handler[method].overloads[i]);
                }
                handler[method].overloads[i].implementation = impl;
            }
        }

        handler.$dispose();
    };

    this._initialize = function () {
        Java.performNow(function () {
            javaHelper._sdk = Java.use('android.os.Build$VERSION')['SDK_INT']['value'];
            if (DEBUG) {
                _log('[' + Process.getCurrentThreadId() + '] ' +
                    'initializing javaHelper with sdk: ' + javaHelper._sdk);
            }

            if (SPAWNED && BREAK_START) {
                if (javaHelper._sdk >= 23) {
                    // attach to commonInit for init debugging
                    javaHelper._hook_in_jvm('com.android.internal.os.RuntimeInit',
                        'commonInit', true, null, false, true);
                } else {
                    javaHelper._hook_in_jvm('android.app.Application', 'onCreate',
                        true, null, false, true);
                }
            }

            // attach to ClassLoader to notify for new loaded class
            var handler = Java.use('java.lang.ClassLoader');
            var overload = handler.loadClass.overload('java.lang.String', 'boolean');
            overload.implementation = function (clazz, resolve) {
                if (javaHelper !== null && javaHelper._java_classes.indexOf(clazz) === -1) {
                    javaHelper._java_classes.push(clazz);
                    loggedSend('class_loader_loading_class:::' + Process.getCurrentThreadId() + ':::' + clazz);

                    var hook = getDwarf().javaOnLoads[clazz];
                    if (typeof hook !== 'undefined') {
                        loggedSend("java_on_load_callback:::" + clazz + ':::' + Process.getCurrentThreadId());
                        getDwarf().breakpoint(REASON_BREAKPOINT, clazz, {}, hook, this);
                    }
                }
                return overload.call(this, clazz, resolve);
            };
        });
    };

    this.getApplicationContext = function () {
        if (!this.available) {
            return;
        }

        var ActivityThread = Java.use('android.app.ActivityThread');
        var Context = Java.use('android.content.Context');

        var context = Java.cast(ActivityThread.currentApplication().getApplicationContext(), Context);

        ActivityThread.$dispose();
        Context.$dispose();

        return context;
    };

    this.hook = function (className, method, shouldBreak, implementation, restore, internal) {
        Java.performNow(function () {
            javaHelper._hook_in_jvm(className, method, shouldBreak, implementation, restore, internal);
        });
    };

    this.hookImplementation = function (className, method, hook, shouldBreak, implementation, overload) {
        return function () {
            var classMethod = className + '.' + method;
            var args = arguments;
            var types = hook.javaOverloads[args.length];
            var newArgs = {};
            for (var i = 0; i < args.length; i++) {
                var value = '';
                if (args[i] === null || typeof args[i] === 'undefined') {
                    value = 'null';
                } else {
                    if (typeof args[i] === 'object') {
                        value = JSON.stringify(args[i]);
                        if (types[i]['className'] === '[B') {
                            value += ' (' + Java.use('java.lang.String').$new(args[i]) + ")";
                        }
                    } else {
                        value = args[i].toString();
                    }
                }
                newArgs[i] = {
                    arg: value,
                    name: types[i]['name'],
                    handle: args[i],
                    className: types[i]['className'],
                }
            }

            // check if clazz is traced
            if (javaHelper._traced_classes.indexOf(classMethod) >= 0) {
                // call trace implementation
                javaHelper.traceImplementation(classMethod).apply(this, arguments);
            }

            if (typeof implementation === 'function') {
                var result = implementation.call(this, args);
            }
            if (shouldBreak) {
                getDwarf().breakpoint(REASON_BREAKPOINT, classMethod, newArgs, hook, this);
            }
            if (typeof result === 'undefined') {
                return overload.apply(this, args);
            } else {
                return result;
            }
        };
    };

    this.startTrace = function (classes, callback) {
        if (!javaHelper.available || javaHelper._tracing) {
            return false;
        }

        javaHelper._tracing = true;
        javaHelper._traced_classes = classes;
        javaHelper._apply_tracer_implementations(true, callback);

        return true;
    };

    this.stopTrace = function () {
        if (!javaHelper.available || !javaHelper._tracing) {
            return false;
        }

        javaHelper._tracing = false;
        javaHelper._apply_tracer_implementations(true);

        return true;
    };

    this.traceImplementation = function (callback, className, method) {
        return function () {
            const uiCallback = !isDefined(callback);
            const classMethod = className + '.' + method;

            if (uiCallback) {
                loggedSend('java_trace:::enter:::' + classMethod + ':::' + JSON.stringify(arguments));
            } else {
                if (isDefined(callback['onEnter'])) {
                    callback['onEnter'](arguments);
                }
            }

            var ret = this[method].apply(this, arguments);

            if (uiCallback) {
                var traceRet = ret;
                if (typeof traceRet === 'object') {
                    traceRet = JSON.stringify(ret);
                } else if (typeof traceRet === 'undefined') {
                    traceRet = "";
                }
                loggedSend('java_trace:::leave:::' + classMethod + ':::' + traceRet);
            } else {
                if (isDefined(callback['onLeave'])) {
                    var tempRet = callback['onLeave'](ret);
                    if (typeof tempRet !== 'undefined') {
                        ret = tempRet;
                    }
                }
            }
            return ret;
        }
    }
}

function MemoryWatcher(address, perm, flags) {
    this.address = address;
    this.debugSymbol = DebugSymbol.fromAddress(address);
    this.flags = flags;
    this.original_permissions = perm;
    var _this = this;

    this.watch = function () {
        var perm = '';
        if (_this.flags & MEMORY_ACCESS_READ) {
            perm += '-';
        } else {
            perm += _this.original_permissions[0];
        }
        if (_this.flags & MEMORY_ACCESS_WRITE) {
            perm += '-';
        } else {
            perm += _this.original_permissions[1];
        }
        if (_this.flags & MEMORY_ACCESS_EXECUTE) {
            perm += '-';
        } else {
            if (_this.original_permissions[2] === 'x') {
                perm += 'x';
            } else {
                perm += '-';
            }
        }
        Memory.protect(_this.address, 1, perm);
    };

    this.restore = function () {
        Memory.protect(_this.address, 1, _this.original_permissions)
    };
}

function StalkerInfo(tid) {
    this.tid = tid;
    this.context = null;
    this.initialContextAddress = NULL;
    this.lastContextAddress = NULL;
    this.didFistJumpOut = false;
    this.hookBackup = null;
    this.terminated = false;
    this.currentMode = null;
    this.lastBlockInstruction = null;
    this.lastCallJumpInstruction = null;
}

rpc.exports = {
    api: function (tid, api_funct, args) {
        if (DEBUG) {
            _log('[' + tid + '] RPC-API: ' + api_funct + ' | ' +
                'args: ' + args + ' (' + Process.getCurrentThreadId() + ')');
        }

        if (typeof args === 'undefined' || args === null) {
            args = [];
        }

        if (Object.keys(getDwarf().hook_contexts).length > 0) {
            var hc = getDwarf().hook_contexts[tid];
            if (typeof hc !== 'undefined') {
                const hook_api = new HookApi(api_funct, args);
                hc.api_queue.push(hook_api);
                const start = Date.now();
                while (!hook_api.consumed) {
                    Thread.sleep(0.5);
                    if (DEBUG) {
                        _log('[' + tid + '] RPC-API: ' + api_funct + ' waiting for api result');
                    }
                    if (Date.now() - start > 3 * 1000) {
                        hook_api.result = '';
                        break;
                    }
                }
                var ret = hook_api.result;
                if (DEBUG) {
                    _log('[' + tid + '] RPC-API: ' + api_funct + ' api result: ' + ret);
                }
                return ret;
            }
        }

        return api[api_funct].apply(this, args)
    },
    init: function (break_start, debug, spawned) {
        BREAK_START = break_start;
        DEBUG = debug;
        SPAWNED = spawned;

        getDwarf().start();
        getDwarf().sendInfos(REASON_SET_INITIAL_CONTEXT, null, null);
    },
    debugdwarfjs: function () {
        return JSON.stringify(getDwarf());
    },
    hooks: function () {
        return JSON.stringify(getDwarf().hooks);
    },
    javaonloads: function () {
        return JSON.stringify(getDwarf().javaOnLoads);
    },
    keywords: function() {
        const map = [];
        Object.getOwnPropertyNames(global).forEach(function (name) {
            map.push(name);

            // second level
            if (isDefined(global[name])) {
                Object.getOwnPropertyNames(global[name]).forEach(function (sec_name) {
                    map.push(sec_name);
                });
            }
        });
        return uniqueBy(map);
    },
    nativeonloads: function () {
        return JSON.stringify(getDwarf().nativeOnLoads);
    },
    reload: function() {
        getDwarf().initializeApi();
    },
    watchers: function () {
        return JSON.stringify(getDwarf().memory_watchers);
    }
};

var __log = console.log;
console.log = function () {
    const args = arguments;
    var to_log = null;
    Object.keys(args).forEach(function (argN) {
        var what = args[argN];
        if (what instanceof ArrayBuffer) {
            what = hexdump(what);
            api.log(what);
        } else {
            if (what instanceof Object) {
                what = JSON.stringify(what, null, 2);
            }

            if (to_log === null) {
                to_log = what;
            } else {
                to_log += '\t' + what;
            }
        }
    });

    if (to_log !== null) {
        api.log(to_log);
    }
};
var _log = function () {
    const date = new Date();
    const now = date.getHourMinuteSecond();
    const args = arguments;
    var to_log = '';
    Object.keys(args).forEach(function (argN) {
        var what = args[argN];

        if (what instanceof ArrayBuffer) {
            __log(hexdump(what))
        } else if (what instanceof Object) {
            what = JSON.stringify(what, null, 2);
        }

        if (to_log !== '') {
            to_log += '\t';
        }
        to_log += what;
    });

    if (to_log !== '') {
        __log(now + ' ' + to_log);
    }
};
var _log_err = function (tag, err) {
    _log('[ERROR-' + tag + '] ' + err);
};

var wrappedInterceptor = Interceptor;
var InterceptorWrapper = function () {
    const _getOption = function (options, key, def) {
        var ret = options[key];
        if (typeof ret !== 'undefined') {
            return ret;
        }
        return def;
    };
    this.attach = function (pt, logic, options) {
        try {
            options = options || {};

            var hook;
            var dethumbedPtr;
            if (pt instanceof Hook) {
                hook = pt;
                dethumbedPtr = dethumbify(hook.nativePtr);
                options = hook.options;
                if (typeof logic === 'undefined' && hook.logic !== null) {
                    logic = hook.logic;
                }
            } else {
                dethumbedPtr = dethumbify(ptr(pt));
                hook = getDwarf().hooks[dethumbedPtr];
                if (typeof hook === 'undefined') {
                    hook = new Hook();
                    hook.nativePtr = ptr(pt);
                    hook.debugSymbol = DebugSymbol.fromAddress(hook.nativePtr)
                } else {
                    pt = hook;
                }
                hook.logic = logic;
            }

            var internal = _getOption(options, '_internal', false);
            var showDetails = _getOption(options, 'details', true);

            hook.internalHook = internal;
            hook.showDetails = showDetails;
            hook.options = options;

            // we will send this for range class and avoid showing frida trampolines when dumping ranges
            hook.bytes = ba2hex(Memory.readByteArray(dethumbedPtr, Process.pointerSize * 2));

            if (typeof logic === 'function') {
                hook.interceptor = Interceptor.attach(hook.nativePtr, function (args) {
                    const tid = Process.getCurrentThreadId();

                    getDwarf().native_contexts[tid] = this.context;
                    hook.interceptorArgs = args;

                    getDwarf().breakpoint(REASON_BREAKPOINT, hook.nativePtr, this.context, hook, null);

                    delete getDwarf().native_contexts[tid];
                });
            } else if (typeof logic === 'object') {
                hook.interceptor = Interceptor.attach(hook.nativePtr, {
                    onEnter: function (args) {
                        this.tid = Process.getCurrentThreadId();

                        getDwarf().native_contexts[this.tid] = this.context;
                        hook.interceptorArgs = args;

                        if (isDefined(logic['onEnter'])) {
                            logic['onEnter'].call(this, args);
                        }
                    },
                    onLeave: function (retval) {
                        if (isDefined(logic['onLeave'])) {
                            logic['onLeave'].call(this, retval);
                        }

                        delete getDwarf().native_contexts[this.tid];
                    }
                });
            } else {
                hook.interceptor = Interceptor.attach(hook.nativePtr, function (args) {
                    const tid = Process.getCurrentThreadId();
                    getDwarf().native_contexts[tid] = this.context;

                    getDwarf().breakpoint(REASON_BREAKPOINT, hook.nativePtr, this.context, hook, null);

                    delete getDwarf().native_contexts[tid];
                });
            }

            var _logic = hook.logic;
            if (typeof _logic !== 'undefined') {
                if (_logic.constructor.name === 'Object') {
                    _logic = '{\n';
                    if (typeof hook.logic['onEnter'] !== 'undefined') {
                        _logic += '    onEnter: ' + hook.logic['onEnter'];
                    }
                    if (typeof hook.logic['onLeave'] !== 'undefined') {
                        if (_logic !== '') {
                            _logic += ',\n'
                        }
                        _logic += '    onLeave: ' + hook.logic['onLeave'] + '\n';
                    }
                    _logic += '}';
                }
            } else {
                _logic = ''
            }

            if (!(pt instanceof Hook)) {
                try {
                    getDwarf().hooks[dethumbedPtr] = hook;
                    loggedSend('hook_native_callback:::' +
                        dethumbify(hook.nativePtr) + ':::' + hook.bytes + ':::' +
                        _logic + ':::' + hook.condition + ':::' + hook.internalHook + ':::' +
                        JSON.stringify(hook.debugSymbol)
                    );
                } catch (e) {
                    _log_err('InterceptorWrapper.attach', e);
                    return false;
                }
            }
            return true;
        } catch (e) {
            _log_err('InterceptorWrapper.attach', e);
            return false;
        }
    };
    this._attach = function (pt, cb) {
        return Interceptor._attach(pt, cb);
    };
    this.detachAll = function () {
        for (var hook in getDwarf().hooks) {
            api.deleteHook(hook);
        }
        for (var hook in getDwarf().nativeOnLoads) {
            api.deleteHook(hook);
        }
        for (var hook in getDwarf().javaOnLoads) {
            api.deleteHook(hook);
        }
    };
    this.flush = function () {
        return Interceptor.flush();
    };
    this._replace = function (pt, nc, ret, args) {
        return Interceptor._replace(pt, nc, ret, args);
    };
    this.replace = function (pt, rep) {
        return Interceptor.replace(pt, rep);
    };
    this.revert = function (target) {
        return Interceptor.revert(target);
    };
};
const DwarfInterceptor = new InterceptorWrapper();

const wrappedThread = Thread;
const ThreadWrapper = function () {
    this._onCreateCallback = null;

    // attempt to retrieve pthread_create
    this.pthread_create_ptr = Module.findExportByName(null, 'pthread_create');
    if (this.pthread_create_ptr != null && !this.pthread_create_ptr.isNull()) {
        this.pthread_create = new NativeFunction(this.pthread_create_ptr,
            'int', ['pointer', 'pointer', 'pointer', 'pointer']);
        this.handler = null;
        this.handler_fn = null;
    }

    // called at the right moment from the loading chain
    this._init = function () {
        // check if pthread create has been declared
        if (typeof this.pthread_create !== 'undefined') {
            // allocate space for a fake handler which we intercept to run the callback
            this.handler = Memory.alloc(Process.pointerSize);
            // set permissions
            Memory.protect(this.handler, Process.pointerSize, 'rwx');
            if (Process.arch === 'arm64') {
                // arm64 require some fake code to get a trampoline from frida
                Memory.writeByteArray(this.handler, [0xE1, 0x03, 0x01, 0xAA, 0xC0, 0x03, 0x5F, 0xD6]);
            }
            // hook the fake handler
            Interceptor.replace(this.handler, new NativeCallback(function () {
                // null check for handler function
                if (DwarfThread.handler_fn !== null) {
                    // invoke callback
                    var ret = DwarfThread.handler_fn.apply(this);
                    // reset callback (unsafe asf... but we don't care)
                    DwarfThread.handler_fn = null;
                    // return result
                    return ret;
                }
                return 0;
            }, 'int', []));
            // replace pthread_create for fun and profit
            Interceptor.attach(this.pthread_create_ptr, function (args) {
                loggedSend('new_thread:::' + Process.getCurrentThreadId() + ':::' + args[2]);
                if (DwarfThread._onCreateCallback !== null &&
                    typeof DwarfThread._onCreateCallback === 'function') {
                    DwarfThread._onCreateCallback(args[2]);
                }
            });
        }
    };

    this.backtrace = function (context, backtracer) {
        return wrappedThread.backtrace(context, backtracer);
    };

    this.new = function (fn) {
        // check if pthread_create is defined
        if (typeof DwarfThread.pthread_create === 'undefined') {
            return 1;
        }

        // check if fn is a valid function
        if (typeof fn !== 'function') {
            return 2;
        }

        // alocate space for struct pthread_t
        var pthread_t = Memory.alloc(Process.pointerSize);
        // set necessary permissions
        Memory.protect(pthread_t, Process.pointerSize, 'rwx');
        // store the function into thread object
        DwarfThread.handler_fn = fn;
        // spawn the thread
        return DwarfThread.pthread_create(pthread_t, ptr(0), DwarfThread.handler, ptr(0));
    };

    this.sleep = function (delay) {
        wrappedThread.sleep(delay);
    };

    // set a callback for thread creation
    this.onCreate = function (callback) {
        DwarfThread._onCreateCallback = callback;
    };

    this._init();
};
const DwarfThread = new ThreadWrapper();

var loggedSend = function (w, p) {
    if (DEBUG) {
        _log('[' + Process.getCurrentThreadId() + '] sending data to py side | ' + w);
    }

    return send(w, p);
};

/*
    http://man7.org/linux/man-pages/man5/elf.5.html

    #define EI_NIDENT 16

    typedef struct {
        unsigned char e_ident[EI_NIDENT];
        uint16_t      e_type;
        uint16_t      e_machine;
        uint32_t      e_version;
        ElfN_Addr     e_entry;
        ElfN_Off      e_phoff;
        ElfN_Off      e_shoff;
        uint32_t      e_flags;
        uint16_t      e_ehsize;
        uint16_t      e_phentsize;
        uint16_t      e_phnum;
        uint16_t      e_shentsize;
        uint16_t      e_shnum;
        uint16_t      e_shstrndx;
    } ElfN_Ehdr;

    typedef struct {                typedef struct {
        uint32_t   p_type;              uint32_t   p_type;
        Elf32_Off  p_offset;            uint32_t   p_flags;
        Elf32_Addr p_vaddr;             Elf64_Off  p_offset;
        Elf32_Addr p_paddr;             Elf64_Addr p_vaddr;
        uint32_t   p_filesz;            Elf64_Addr p_paddr;
        uint32_t   p_memsz;             uint64_t   p_filesz;
        uint32_t   p_flags;             uint64_t   p_memsz;
        uint32_t   p_align;             uint64_t   p_align;
    } Elf32_Phdr;                   } Elf64_Phdr;

    typedef struct {                typedef struct {
        uint32_t   sh_name;             uint32_t   sh_name;
        uint32_t   sh_type;             uint32_t   sh_type;
        uint32_t   sh_flags;            uint64_t   sh_flags;
        Elf32_Addr sh_addr;             Elf64_Addr sh_addr;
        Elf32_Off  sh_offset;           Elf64_Off  sh_offset;
        uint32_t   sh_size;             uint64_t   sh_size;
        uint32_t   sh_link;             uint32_t   sh_link;
        uint32_t   sh_info;             uint32_t   sh_info;
        uint32_t   sh_addralign;        uint64_t   sh_addralign;
        uint32_t   sh_entsize;          uint64_t   sh_entsize;
    } Elf32_Shdr;                   } Elf64_Shdr;
*/
var ELF_File = (function () {
    var ELF_Header = (function () {
        function ELF_Header(buffer) {
            this.e_ident = [];
            for (var i = 0; i < 0x10; i++) {
                this.e_ident.push(Memory.readU8(buffer.add(i)));
            }
            this.e_type = Memory.readU16(buffer.add(0x10));
            this.e_machine = Memory.readU16(buffer.add(0x12));
            this.e_version = Memory.readU32(buffer.add(0x14));

            var pos = 0;
            if (this.e_ident[4] === 1) { // ELFCLASS32
                this.e_entry = Memory.readU32(buffer.add(0x18));
                this.e_phoff = Memory.readU32(buffer.add(0x1c));
                this.e_shoff = Memory.readU32(buffer.add(0x20));
                pos = 0x24;
            } else if (this.e_ident[4] === 2) { //ELFCLASS64
                this.e_entry = Memory.readU64(buffer.add(0x18)).toNumber();
                this.e_phoff = Memory.readU64(buffer.add(0x20)).toNumber();
                this.e_shoff = Memory.readU64(buffer.add(0x28)).toNumber();
                pos = 0x30;
            } else {
                return null;
            }

            this.e_flags = Memory.readU32(buffer.add(pos));
            this.e_ehsize = Memory.readU16(buffer.add(pos + 0x4));
            this.e_phentsize = Memory.readU16(buffer.add(pos + 0x6));
            this.e_phnum = Memory.readU16(buffer.add(pos + 0x8));
            this.e_shentsize = Memory.readU16(buffer.add(pos + 0xa));
            this.e_shnum = Memory.readU16(buffer.add(pos + 0xc));
            this.e_shstrndx = Memory.readU16(buffer.add(pos + 0xe));

            ELF_Header.prototype.toString = function () {
                var str = [];
                str.push("e_type: 0x" + this.e_type.toString(16));
                str.push("e_machine: 0x" + this.e_machine.toString(16));
                str.push("e_version: 0x" + this.e_version.toString(16));
                str.push("e_entry: 0x" + this.e_entry.toString(16));
                str.push("e_phoff: 0x" + this.e_phoff.toString(16));
                str.push("e_shoff: 0x" + this.e_shoff.toString(16));
                str.push("e_flags: 0x" + this.e_flags.toString(16));
                str.push("e_ehsize: 0x" + this.e_ehsize.toString(16));
                str.push("e_phentsize: 0x" + this.e_phentsize.toString(16));
                str.push("e_phnum: 0x" + this.e_phnum.toString(16));
                str.push("e_shentsize: 0x" + this.e_shentsize.toString(16));
                str.push("e_shnum: 0x" + this.e_shnum.toString(16));
                str.push("e_shstrndx: 0x" + this.e_shstrndx.toString(16));
                return str.join('\n');
            }
        }
        return ELF_Header;
    }());

    var ELF_ProgamHeader = (function () {
        function ELF_ProgamHeader(buffer, is64bit) {
            var PT_TYPE_NAME = {
                0: "NULL",
                1: "LOAD",
                2: "DYNAMIC",
                3: "INTERP",
                4: "NOTE",
                5: "SHLIB",
                6: "PHDR",
                0x60000000: "LOOS",
                0x6474e550: "PT_GNU_EH_FRAME",
                0x6474e551: "PT_GNU_STACK",
                0x6474e552: "PT_GNU_RELO",
                0x6fffffff: "HIOS",
                0x70000000: "LOPROC",
                0x7fffffff: "HIPROC"
            };
            this.p_type = Memory.readU32(buffer);
            if (!is64bit) {
                this.p_offset = Memory.readU32(buffer.add(0x4));
                this.p_vaddr = Memory.readU32(buffer.add(0x8));
                this.p_paddr = Memory.readU32(buffer.add(0xc));
                this.p_filesz = Memory.readU32(buffer.add(0x10));
                this.p_memsz = Memory.readU32(buffer.add(0x14));
                this.p_flags = Memory.readU32(buffer.add(0x18));
                this.p_align = Memory.readU32(buffer.add(0x1c));
            } else {
                this.p_flags = Memory.readU32(buffer.add(0x4));
                this.p_offset = Memory.readU64(buffer.add(0x8)).toNumber();
                this.p_vaddr = Memory.readU64(buffer.add(0x10)).toNumber();
                this.p_paddr = Memory.readU64(buffer.add(0x18)).toNumber();
                this.p_filesz = Memory.readU64(buffer.add(0x20)).toNumber();
                this.p_memsz = Memory.readU64(buffer.add(0x28)).toNumber();
                this.p_align = Memory.readU64(buffer.add(0x30)).toNumber();
            }

            ELF_ProgamHeader.prototype.toString = function () {
                var str = [];
                str.push("p_type: 0x" + this.p_type.toString(16) + " - " + PT_TYPE_NAME[this.p_type]);
                str.push("p_offset: 0x" + this.p_offset.toString(16));
                str.push("p_vaddr: 0x" + this.p_vaddr.toString(16));
                str.push("p_paddr: 0x" + this.p_paddr.toString(16));
                str.push("p_filesz: 0x" + this.p_filesz.toString(16));
                str.push("p_memsz: 0x" + this.p_memsz.toString(16));
                str.push("p_flags: 0x" + this.p_flags.toString(16));
                str.push("p_align: 0x" + this.p_align.toString(16));
                return str.join('\n');
            }
        }
        return ELF_ProgamHeader;
    }());

    var ELF_SectionHeader = (function () {
        function ELF_SectionHeader(buffer, is64bit) {
            var SH_TYPE_NAME = {
                0: "NULL",
                1: "PROGBITS",
                2: "SYMTAB",
                3: "STRTAB",
                4: "RELA",
                5: "HASH",
                6: "DYNAMIC",
                7: "NOTE",
                8: "NOBITS",
                9: "REL",
                10: "SHLIB",
                11: "DYNSYM",
                14: "INIT_ARRAY",
                15: "FINI_ARRAY",
                16: "PREINIT_ARRAY",
                17: "GROUP",
                18: "SYMTAB_SHNDX",
                19: "RELR",
                0x60000000: "LOOS",
                0x60000001: "ANDROID_REL",
                0x60000002: "ANDROID_RELA",
                0x6fff4c00: "LLVM_ORDTAB",
                0x6fff4c01: "LLVM_LINKER_OPTIONS",
                0x6fff4c02: "LLVM_CALL_GRAPH_PROFILE",
                0x6fff4c03: "LLVM_ADDRSIG",
                0x6fff4c04: "LLVM_DEPENDENT_LIBRARIES",
                0x6fffff00: "ANDROID_RELR",
                0x6ffffff5: "GNU_ATTRIBUTES",
                0x6fffffff: "GNU_VERSYM",
                0x6ffffff6: "GNU_HASH",
                0x6ffffffd: "GNU_VERDEF",
                0x6ffffffe: "GNU_VERNEED",
                0x70000000: "LOPROC",
                0x7fffffff: "HIPROC",
                0x80000000: "LOUSER",
                0xffffffff: "HIUSER"
            };
            this.name = "";
            this.sh_name = Memory.readU32(buffer.add(0x0));
            this.sh_type = Memory.readU32(buffer.add(0x4));
            if (!is64bit) {
                this.sh_flags = Memory.readU32(buffer.add(0x8));
                this.sh_addr = Memory.readU32(buffer.add(0xc));
                this.sh_offset = Memory.readU32(buffer.add(0x10));
                this.sh_size = Memory.readU32(buffer.add(0x14));
                this.sh_link = Memory.readU32(buffer.add(0x18));
                this.sh_info = Memory.readU32(buffer.add(0x1c));
                this.sh_addralign = Memory.readU32(buffer.add(0x20));
                this.sh_entsize = Memory.readU32(buffer.add(0x24));
            } else {
                this.sh_flags = Memory.readU64(buffer.add(0x8)).toNumber();
                this.sh_addr = Memory.readU64(buffer.add(0x10)).toNumber();
                this.sh_offset = Memory.readU64(buffer.add(0x18)).toNumber();
                this.sh_size = Memory.readU64(buffer.add(0x20)).toNumber();
                this.sh_link = Memory.readU32(buffer.add(0x28));
                this.sh_info = Memory.readU32(buffer.add(0x2c));
                this.sh_addralign = Memory.readU64(buffer.add(0x30)).toNumber();
                this.sh_entsize = Memory.readU64(buffer.add(0x38)).toNumber();
            }

            ELF_SectionHeader.prototype.toString = function () {
                var str = [];
                str.push("sh_name: 0x" + this.sh_name.toString(16) + " - " + this.name);
                str.push("sh_type: 0x" + this.sh_type.toString(16) + " - " + SH_TYPE_NAME[this.sh_type]);
                str.push("sh_flags: 0x" + this.sh_flags.toString(16));
                str.push("sh_addr: 0x" + this.sh_addr.toString(16));
                str.push("sh_offset: 0x" + this.sh_offset.toString(16));
                str.push("sh_size: 0x" + this.sh_size.toString(16));
                str.push("sh_link: 0x" + this.sh_link.toString(16));
                str.push("sh_info: 0x" + this.sh_info.toString(16));
                str.push("sh_addralign: 0x" + this.sh_addralign.toString(16));
                str.push("sh_entsize: 0x" + this.sh_entsize.toString(16));
                return str.join('\n');
            }
        }
        return ELF_SectionHeader;
    }());

    function ELF_File(path) {
        if (!isString(path)) {
            __log('No Path');
            return {};
        }
        this.header = null;
        this.sectionheaders = [];
        this.programheaders = [];
        this.is64bit = false;

        var _file = fs.fopen(path, 'r');
        if (_file.isNull()) {
            __log('failed to open file');
            return {};
        }

        var headerBuffer = fs.allocateRw(0x40);
        if (headerBuffer.isNull()) {
            __log('alloc failed');
            fs.fclose(_file);
            return {};
        }

        if (fs.fread(headerBuffer, 1, 0x40, _file) !== 0x40) {
            __log('failed to read');
            fs.fclose(_file);
            return {};
        }
        this.header = new ELF_Header(headerBuffer);

        if (this.header.e_ident[0] !== 0x7f || this.header.e_ident[1] !== 0x45 ||
            this.header.e_ident[2] !== 0x4c || this.header.e_ident[3] !== 0x46) {
            __log('no elf file');
            fs.fclose(_file);
            return {};
        }

        if (this.header.e_ident[6] !== 1) {
            fs.fclose(_file);
            __log('no elf file');
            return {};
        }

        if (this.header.e_version !== 1) {
            fs.fclose(_file);
            __log('no elf file');
            return {};
        }

        if (this.header.e_ident[4] === 0) {
            fs.fclose(_file);
            __log('no elf file');
            return {};
        } else if (this.header.e_ident[4] === 1) {
            this.is64bit = false;
        } else if (this.header.e_ident[4] === 2) {
            this.is64bit = true;
        }

        if (this.header.e_ident[5] === 0) {
            fs.fclose(_file);
            __log('no elf file');
            return {};
        } else if (this.header.e_ident[5] === 1) {
            this.endian = 'little';
        } else if (this.header.e_ident[5] === 2) {
            this.endian = 'big';
        }

        //get progheaders
        var progHeadersBuffer = fs.allocateRw(this.header.e_phnum * this.header.e_phentsize);
        if (progHeadersBuffer.isNull()) {
            __log('alloc failed');
            fs.fclose(_file);
            return {};
        }

        if (fs.fseek(_file, this.header.e_phoff, 0) !== 0) {
            __log('fseek failed');
            fs.fclose(_file);
            return {};
        }

        if (fs.fread(progHeadersBuffer, 1, this.header.e_phentsize * this.header.e_phnum, _file) !==
            (this.header.e_phentsize * this.header.e_phnum)) {
            __log('failed to read');
            fs.fclose(_file);
            return {};
        }

        for (var i = 0; i < this.header.e_phnum; i++) {
            this.programheaders.push(new ELF_ProgamHeader(progHeadersBuffer.add(this.header.e_phentsize * i), this.is64bit));
        }

        var strTableBuffer = fs.allocateRw(this.header.e_shentsize);
        if (strTableBuffer.isNull()) {
            __log('alloc failed');
            fs.fclose(_file);
            return {};
        }

        //get strtable
        if (fs.fseek(_file, this.header.e_shoff + this.header.e_shentsize * this.header.e_shstrndx, 0) !== 0) {
            __log('fseek failed');
            fs.fclose(_file);
            return {};
        }
        if (fs.fread(strTableBuffer, 1, this.header.e_shentsize, _file) !== this.header.e_shentsize) {
            __log('failed to read');
            fs.fclose(_file);
            return {};
        }
        var section = new ELF_SectionHeader(strTableBuffer, this.is64bit);

        if (fs.fseek(_file, section.sh_offset, 0) !== 0) {
            __log('fseek failed');
            fs.fclose(_file);
            return {};
        }

        var strSectionBuffer = fs.allocateRw(section.sh_size);
        if (strSectionBuffer.isNull()) {
            __log('alloc failed');
            fs.fclose(_file);
            return {};
        }

        if (fs.fread(strSectionBuffer, 1, section.sh_size, _file) !== section.sh_size) {
            __log('failed to read');
            fs.fclose(_file);
            return {};
        }

        var string_table = [];
        var pos = 0;
        while (pos < section.sh_size) {
            var str = Memory.readCString(strSectionBuffer.add(pos));
            if (str.length > 0) {
                string_table[pos] = str;
                pos += str.length + 1;
            } else {
                string_table[pos] = "";
                pos += 1;
            }
        }

        //get sesctions
        var sectionsBuffer = fs.allocateRw(this.header.e_shentsize * this.header.e_shnum);
        if (sectionsBuffer.isNull()) {
            __log('alloc failed');
            fs.fclose(_file);
            return {};
        }

        if (fs.fseek(_file, this.header.e_shoff, 0) !== 0) {
            __log('fseek failed');
            fs.fclose(_file);
            return {};
        }

        if (fs.fread(sectionsBuffer, 1, this.header.e_shentsize * this.header.e_shnum, _file) !== this.header.e_shentsize * this.header.e_shnum) {
            __log('failed to read');
            fs.fclose(_file);
            return {};
        }

        for (var i = 0; i < this.header.e_shnum; i++) {
            section = new ELF_SectionHeader(sectionsBuffer.add(this.header.e_shentsize * i), this.is64bit);
            section.name = Memory.readCString(strSectionBuffer.add(section.sh_name));

            if (section.name === '.init_array') {
                var initArrayBuffer = fs.allocateRw(section.sh_size);
                if (fs.fseek(_file, section.sh_offset, 0) !== 0) {
                    __log('fseek failed');
                    fs.fclose(_file);
                    return {};
                }
                if (fs.fread(initArrayBuffer, 1, section.sh_size, _file) !== section.sh_size) {
                    __log('failed to read');
                    fs.fclose(_file);
                    return {};
                }
                section.data = [];
                var size = 4;
                if (this.is64bit) {
                    size += 4;
                }
                for (var a = 0; a < section.sh_size; a += size) {
                    if (this.is64bit) {
                        section.data.push(Memory.readU64(initArrayBuffer.add(a)).toNumber());
                    } else {
                        section.data.push(Memory.readU32(initArrayBuffer.add(a)));
                    }
                }
            }
            //section.name = string_table[section.sh_name];

            //add to str_table
            /*if(section.sh_type == 3) { // STRTAB
                fs.fseek(_file, section.sh_offset, 0);
                buf2 = fs.allocateRw(section.sh_size);
                fs.fgets(buf2, section.sh_size, _file);
                var pos = 0;
                while(pos < section.sh_size) {
                    var str = Memory.readCString(buf2.add(pos));
                    if(str.length > 0) {
                        this.string_table.push(str);
                        pos += str.length + 1;
                    } else {
                        this.string_table.push("");
                        pos += 1;
                    }
                }
            }*/
            this.sectionheaders.push(section);
        }
        fs.fclose(_file);
    }
    return ELF_File;
}());

import { EventEmitter } from 'events';
import process from 'process';

class ChannelMessageCodec {
    static serialize(payload) {
        const eventName = payload.eventName;
        const args = payload.args;
        const eventMessage = JSON.stringify(args);
        const data = {
            eventName,
            eventMessage,
        };
        const channelMessage = JSON.stringify(data);
        return channelMessage;
    }
    static deserialize(channelMessage) {
        const data = JSON.parse(channelMessage);
        const eventName = data.eventName;
        const eventMessage = data.eventMessage;
        let args = [];
        if (eventMessage) {
            args = JSON.parse(eventMessage);
        }
        const payload = {
            eventName,
            args,
        };
        return payload;
    }
}

class NativeMobileBridge {
    constructor() {
        this.mobileBridge = process._linkedBinding('nativeBridge');
    }
    emit(args) {
        this.mobileBridge.emit(args.channelName, args.channelMessage);
    }
    registerChannel(channelName, callback) {
        this.mobileBridge.registerChannel(channelName, (channelName, channelMessage) => {
            callback({ channelName, channelMessage });
        });
    }
}
class NativeDesktopBridge {
    emit(args) {
        if (!process.send) {
            throw new Error('No IPC channel has been established between the Node.js process and the Capacitor layer.');
        }
        process.send(args);
    }
    registerChannel(channelName, callback) {
        process.on('message', (args) => {
            if (args.channelName === channelName) {
                callback(args);
            }
        });
    }
}
const platform = process.platform;
const isMobilePlatform = platform === 'android' || platform === 'ios';
const nativeBridge = isMobilePlatform ? new NativeMobileBridge() : new NativeDesktopBridge();
class Channel extends EventEmitter {
    constructor(channelName) {
        super();
        this.channelName = channelName;
        const self = this;
        nativeBridge.registerChannel(channelName, (args) => {
            const channelMessage = args.channelMessage;
            const payload = ChannelMessageCodec.deserialize(channelMessage);
            self.emitWrapper(payload.eventName, ...payload.args);
        });
    }
    /**
     * Sends a message to the Capacitor layer via eventName, along with arguments.
     * Arguments will be serialized with JSON.
     *
     * @param eventName The name of the event being send to.
     * @param args The Array of arguments to send.
     */
    send(eventName, ...args) {
        if (eventName === undefined || eventName === '') {
            throw new Error("Required parameter 'eventName' was not specified");
        }
        const payload = { eventName, args };
        const channelName = this.channelName;
        const channelMessage = ChannelMessageCodec.serialize(payload);
        const channelPayload = {
            channelName,
            channelMessage,
        };
        nativeBridge.emit(channelPayload);
    }
    emitWrapper(eventName, ...args) {
        const self = this;
        setImmediate(() => {
            self.emit(eventName, ...args);
        });
    }
    /**
     * Listens to `eventName` and calls `listener(args...)` when a new message arrives from the Capacitor layer.
     */
    on(eventName, listener) {
        return super.on(eventName, listener);
    }
    /**
     * Listens one time to `eventName` and calls `listener(args...)` when a new message
     * arrives from the Capacitor layer, after which it is removed.
     */
    once(eventName, listener) {
        return super.once(eventName, listener);
    }
    /**
     * Alias for `channel.on(eventName, listener)`.
     */
    addListener(eventName, listener) {
        return super.addListener(eventName, listener);
    }
    /**
     * Removes the specified `listener` from the listener array for the specified `eventName`.
     */
    removeListener(eventName, listener) {
        return super.removeListener(eventName, listener);
    }
    /**
     * Removes all listeners, or those of the specified `eventName`.
     *
     * @param eventName The name of the event all listeners will be removed from.
     */
    removeAllListeners(eventName) {
        return super.removeAllListeners(eventName);
    }
}
const appChannel = new Channel('APP_CHANNEL');
/**
 * Provides a few methods to send messages from the Node.js process to the Capacitor layer,
 * and to receive replies from the Capacitor layer.
 */
const eventChannel = new Channel('EVENT_CHANNEL');
/**
 * Emitted when the application gains focus.
 */
function onResume(listener) {
    appChannel.on('resume', listener);
}
/**
 * Emitted when the application loses focus.
 */
function onPause(listener) {
    appChannel.on('pause', listener);
}
/**
 * Returns a path for a per-user application data directory on each platform,
 * where data can be read and written.
 */
function getDataPath() {
    const path = process.env['DATADIR'];
    if (!path) {
        throw new Error('Unable to get a directory for persistent data storage.');
    }
    return path;
}

appChannel.send('ready');

export { eventChannel as channel, getDataPath, onPause, onResume };
//# sourceMappingURL=data:application/json;charset=utf-8;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoiaW5kZXgubWpzIiwic291cmNlcyI6WyIuLi8uLi8uLi8uLi8uLi8uLi8uLi9icmlkZ2UvYnVpbGQvYnJpZGdlL3NyYy91dGlscy5qcyIsIi4uLy4uLy4uLy4uLy4uLy4uLy4uL2JyaWRnZS9idWlsZC9icmlkZ2Uvc3JjL2JyaWRnZS5qcyIsIi4uLy4uLy4uLy4uLy4uLy4uLy4uL2JyaWRnZS9idWlsZC9icmlkZ2Uvc3JjL2luZGV4LmpzIl0sInNvdXJjZXNDb250ZW50IjpbImV4cG9ydCBjbGFzcyBDaGFubmVsTWVzc2FnZUNvZGVjIHtcbiAgICBzdGF0aWMgc2VyaWFsaXplKHBheWxvYWQpIHtcbiAgICAgICAgY29uc3QgZXZlbnROYW1lID0gcGF5bG9hZC5ldmVudE5hbWU7XG4gICAgICAgIGNvbnN0IGFyZ3MgPSBwYXlsb2FkLmFyZ3M7XG4gICAgICAgIGNvbnN0IGV2ZW50TWVzc2FnZSA9IEpTT04uc3RyaW5naWZ5KGFyZ3MpO1xuICAgICAgICBjb25zdCBkYXRhID0ge1xuICAgICAgICAgICAgZXZlbnROYW1lLFxuICAgICAgICAgICAgZXZlbnRNZXNzYWdlLFxuICAgICAgICB9O1xuICAgICAgICBjb25zdCBjaGFubmVsTWVzc2FnZSA9IEpTT04uc3RyaW5naWZ5KGRhdGEpO1xuICAgICAgICByZXR1cm4gY2hhbm5lbE1lc3NhZ2U7XG4gICAgfVxuICAgIHN0YXRpYyBkZXNlcmlhbGl6ZShjaGFubmVsTWVzc2FnZSkge1xuICAgICAgICBjb25zdCBkYXRhID0gSlNPTi5wYXJzZShjaGFubmVsTWVzc2FnZSk7XG4gICAgICAgIGNvbnN0IGV2ZW50TmFtZSA9IGRhdGEuZXZlbnROYW1lO1xuICAgICAgICBjb25zdCBldmVudE1lc3NhZ2UgPSBkYXRhLmV2ZW50TWVzc2FnZTtcbiAgICAgICAgbGV0IGFyZ3MgPSBbXTtcbiAgICAgICAgaWYgKGV2ZW50TWVzc2FnZSkge1xuICAgICAgICAgICAgYXJncyA9IEpTT04ucGFyc2UoZXZlbnRNZXNzYWdlKTtcbiAgICAgICAgfVxuICAgICAgICBjb25zdCBwYXlsb2FkID0ge1xuICAgICAgICAgICAgZXZlbnROYW1lLFxuICAgICAgICAgICAgYXJncyxcbiAgICAgICAgfTtcbiAgICAgICAgcmV0dXJuIHBheWxvYWQ7XG4gICAgfVxufVxuLy8jIHNvdXJjZU1hcHBpbmdVUkw9dXRpbHMuanMubWFwIiwiaW1wb3J0IHsgRXZlbnRFbWl0dGVyIH0gZnJvbSAnZXZlbnRzJztcbmltcG9ydCBwcm9jZXNzIGZyb20gJ3Byb2Nlc3MnO1xuaW1wb3J0IHsgQ2hhbm5lbE1lc3NhZ2VDb2RlYyB9IGZyb20gJy4vdXRpbHMnO1xuY2xhc3MgTmF0aXZlTW9iaWxlQnJpZGdlIHtcbiAgICBjb25zdHJ1Y3RvcigpIHtcbiAgICAgICAgdGhpcy5tb2JpbGVCcmlkZ2UgPSBwcm9jZXNzLl9saW5rZWRCaW5kaW5nKCduYXRpdmVCcmlkZ2UnKTtcbiAgICB9XG4gICAgZW1pdChhcmdzKSB7XG4gICAgICAgIHRoaXMubW9iaWxlQnJpZGdlLmVtaXQoYXJncy5jaGFubmVsTmFtZSwgYXJncy5jaGFubmVsTWVzc2FnZSk7XG4gICAgfVxuICAgIHJlZ2lzdGVyQ2hhbm5lbChjaGFubmVsTmFtZSwgY2FsbGJhY2spIHtcbiAgICAgICAgdGhpcy5tb2JpbGVCcmlkZ2UucmVnaXN0ZXJDaGFubmVsKGNoYW5uZWxOYW1lLCAoY2hhbm5lbE5hbWUsIGNoYW5uZWxNZXNzYWdlKSA9PiB7XG4gICAgICAgICAgICBjYWxsYmFjayh7IGNoYW5uZWxOYW1lLCBjaGFubmVsTWVzc2FnZSB9KTtcbiAgICAgICAgfSk7XG4gICAgfVxufVxuY2xhc3MgTmF0aXZlRGVza3RvcEJyaWRnZSB7XG4gICAgZW1pdChhcmdzKSB7XG4gICAgICAgIGlmICghcHJvY2Vzcy5zZW5kKSB7XG4gICAgICAgICAgICB0aHJvdyBuZXcgRXJyb3IoJ05vIElQQyBjaGFubmVsIGhhcyBiZWVuIGVzdGFibGlzaGVkIGJldHdlZW4gdGhlIE5vZGUuanMgcHJvY2VzcyBhbmQgdGhlIENhcGFjaXRvciBsYXllci4nKTtcbiAgICAgICAgfVxuICAgICAgICBwcm9jZXNzLnNlbmQoYXJncyk7XG4gICAgfVxuICAgIHJlZ2lzdGVyQ2hhbm5lbChjaGFubmVsTmFtZSwgY2FsbGJhY2spIHtcbiAgICAgICAgcHJvY2Vzcy5vbignbWVzc2FnZScsIChhcmdzKSA9PiB7XG4gICAgICAgICAgICBpZiAoYXJncy5jaGFubmVsTmFtZSA9PT0gY2hhbm5lbE5hbWUpIHtcbiAgICAgICAgICAgICAgICBjYWxsYmFjayhhcmdzKTtcbiAgICAgICAgICAgIH1cbiAgICAgICAgfSk7XG4gICAgfVxufVxuY29uc3QgcGxhdGZvcm0gPSBwcm9jZXNzLnBsYXRmb3JtO1xuY29uc3QgaXNNb2JpbGVQbGF0Zm9ybSA9IHBsYXRmb3JtID09PSAnYW5kcm9pZCcgfHwgcGxhdGZvcm0gPT09ICdpb3MnO1xuY29uc3QgbmF0aXZlQnJpZGdlID0gaXNNb2JpbGVQbGF0Zm9ybSA/IG5ldyBOYXRpdmVNb2JpbGVCcmlkZ2UoKSA6IG5ldyBOYXRpdmVEZXNrdG9wQnJpZGdlKCk7XG5jbGFzcyBDaGFubmVsIGV4dGVuZHMgRXZlbnRFbWl0dGVyIHtcbiAgICBjb25zdHJ1Y3RvcihjaGFubmVsTmFtZSkge1xuICAgICAgICBzdXBlcigpO1xuICAgICAgICB0aGlzLmNoYW5uZWxOYW1lID0gY2hhbm5lbE5hbWU7XG4gICAgICAgIGNvbnN0IHNlbGYgPSB0aGlzO1xuICAgICAgICBuYXRpdmVCcmlkZ2UucmVnaXN0ZXJDaGFubmVsKGNoYW5uZWxOYW1lLCAoYXJncykgPT4ge1xuICAgICAgICAgICAgY29uc3QgY2hhbm5lbE1lc3NhZ2UgPSBhcmdzLmNoYW5uZWxNZXNzYWdlO1xuICAgICAgICAgICAgY29uc3QgcGF5bG9hZCA9IENoYW5uZWxNZXNzYWdlQ29kZWMuZGVzZXJpYWxpemUoY2hhbm5lbE1lc3NhZ2UpO1xuICAgICAgICAgICAgc2VsZi5lbWl0V3JhcHBlcihwYXlsb2FkLmV2ZW50TmFtZSwgLi4ucGF5bG9hZC5hcmdzKTtcbiAgICAgICAgfSk7XG4gICAgfVxuICAgIC8qKlxuICAgICAqIFNlbmRzIGEgbWVzc2FnZSB0byB0aGUgQ2FwYWNpdG9yIGxheWVyIHZpYSBldmVudE5hbWUsIGFsb25nIHdpdGggYXJndW1lbnRzLlxuICAgICAqIEFyZ3VtZW50cyB3aWxsIGJlIHNlcmlhbGl6ZWQgd2l0aCBKU09OLlxuICAgICAqXG4gICAgICogQHBhcmFtIGV2ZW50TmFtZSBUaGUgbmFtZSBvZiB0aGUgZXZlbnQgYmVpbmcgc2VuZCB0by5cbiAgICAgKiBAcGFyYW0gYXJncyBUaGUgQXJyYXkgb2YgYXJndW1lbnRzIHRvIHNlbmQuXG4gICAgICovXG4gICAgc2VuZChldmVudE5hbWUsIC4uLmFyZ3MpIHtcbiAgICAgICAgaWYgKGV2ZW50TmFtZSA9PT0gdW5kZWZpbmVkIHx8IGV2ZW50TmFtZSA9PT0gJycpIHtcbiAgICAgICAgICAgIHRocm93IG5ldyBFcnJvcihcIlJlcXVpcmVkIHBhcmFtZXRlciAnZXZlbnROYW1lJyB3YXMgbm90IHNwZWNpZmllZFwiKTtcbiAgICAgICAgfVxuICAgICAgICBjb25zdCBwYXlsb2FkID0geyBldmVudE5hbWUsIGFyZ3MgfTtcbiAgICAgICAgY29uc3QgY2hhbm5lbE5hbWUgPSB0aGlzLmNoYW5uZWxOYW1lO1xuICAgICAgICBjb25zdCBjaGFubmVsTWVzc2FnZSA9IENoYW5uZWxNZXNzYWdlQ29kZWMuc2VyaWFsaXplKHBheWxvYWQpO1xuICAgICAgICBjb25zdCBjaGFubmVsUGF5bG9hZCA9IHtcbiAgICAgICAgICAgIGNoYW5uZWxOYW1lLFxuICAgICAgICAgICAgY2hhbm5lbE1lc3NhZ2UsXG4gICAgICAgIH07XG4gICAgICAgIG5hdGl2ZUJyaWRnZS5lbWl0KGNoYW5uZWxQYXlsb2FkKTtcbiAgICB9XG4gICAgZW1pdFdyYXBwZXIoZXZlbnROYW1lLCAuLi5hcmdzKSB7XG4gICAgICAgIGNvbnN0IHNlbGYgPSB0aGlzO1xuICAgICAgICBzZXRJbW1lZGlhdGUoKCkgPT4ge1xuICAgICAgICAgICAgc2VsZi5lbWl0KGV2ZW50TmFtZSwgLi4uYXJncyk7XG4gICAgICAgIH0pO1xuICAgIH1cbiAgICAvKipcbiAgICAgKiBMaXN0ZW5zIHRvIGBldmVudE5hbWVgIGFuZCBjYWxscyBgbGlzdGVuZXIoYXJncy4uLilgIHdoZW4gYSBuZXcgbWVzc2FnZSBhcnJpdmVzIGZyb20gdGhlIENhcGFjaXRvciBsYXllci5cbiAgICAgKi9cbiAgICBvbihldmVudE5hbWUsIGxpc3RlbmVyKSB7XG4gICAgICAgIHJldHVybiBzdXBlci5vbihldmVudE5hbWUsIGxpc3RlbmVyKTtcbiAgICB9XG4gICAgLyoqXG4gICAgICogTGlzdGVucyBvbmUgdGltZSB0byBgZXZlbnROYW1lYCBhbmQgY2FsbHMgYGxpc3RlbmVyKGFyZ3MuLi4pYCB3aGVuIGEgbmV3IG1lc3NhZ2VcbiAgICAgKiBhcnJpdmVzIGZyb20gdGhlIENhcGFjaXRvciBsYXllciwgYWZ0ZXIgd2hpY2ggaXQgaXMgcmVtb3ZlZC5cbiAgICAgKi9cbiAgICBvbmNlKGV2ZW50TmFtZSwgbGlzdGVuZXIpIHtcbiAgICAgICAgcmV0dXJuIHN1cGVyLm9uY2UoZXZlbnROYW1lLCBsaXN0ZW5lcik7XG4gICAgfVxuICAgIC8qKlxuICAgICAqIEFsaWFzIGZvciBgY2hhbm5lbC5vbihldmVudE5hbWUsIGxpc3RlbmVyKWAuXG4gICAgICovXG4gICAgYWRkTGlzdGVuZXIoZXZlbnROYW1lLCBsaXN0ZW5lcikge1xuICAgICAgICByZXR1cm4gc3VwZXIuYWRkTGlzdGVuZXIoZXZlbnROYW1lLCBsaXN0ZW5lcik7XG4gICAgfVxuICAgIC8qKlxuICAgICAqIFJlbW92ZXMgdGhlIHNwZWNpZmllZCBgbGlzdGVuZXJgIGZyb20gdGhlIGxpc3RlbmVyIGFycmF5IGZvciB0aGUgc3BlY2lmaWVkIGBldmVudE5hbWVgLlxuICAgICAqL1xuICAgIHJlbW92ZUxpc3RlbmVyKGV2ZW50TmFtZSwgbGlzdGVuZXIpIHtcbiAgICAgICAgcmV0dXJuIHN1cGVyLnJlbW92ZUxpc3RlbmVyKGV2ZW50TmFtZSwgbGlzdGVuZXIpO1xuICAgIH1cbiAgICAvKipcbiAgICAgKiBSZW1vdmVzIGFsbCBsaXN0ZW5lcnMsIG9yIHRob3NlIG9mIHRoZSBzcGVjaWZpZWQgYGV2ZW50TmFtZWAuXG4gICAgICpcbiAgICAgKiBAcGFyYW0gZXZlbnROYW1lIFRoZSBuYW1lIG9mIHRoZSBldmVudCBhbGwgbGlzdGVuZXJzIHdpbGwgYmUgcmVtb3ZlZCBmcm9tLlxuICAgICAqL1xuICAgIHJlbW92ZUFsbExpc3RlbmVycyhldmVudE5hbWUpIHtcbiAgICAgICAgcmV0dXJuIHN1cGVyLnJlbW92ZUFsbExpc3RlbmVycyhldmVudE5hbWUpO1xuICAgIH1cbn1cbmNvbnN0IGFwcENoYW5uZWwgPSBuZXcgQ2hhbm5lbCgnQVBQX0NIQU5ORUwnKTtcbi8qKlxuICogUHJvdmlkZXMgYSBmZXcgbWV0aG9kcyB0byBzZW5kIG1lc3NhZ2VzIGZyb20gdGhlIE5vZGUuanMgcHJvY2VzcyB0byB0aGUgQ2FwYWNpdG9yIGxheWVyLFxuICogYW5kIHRvIHJlY2VpdmUgcmVwbGllcyBmcm9tIHRoZSBDYXBhY2l0b3IgbGF5ZXIuXG4gKi9cbmNvbnN0IGV2ZW50Q2hhbm5lbCA9IG5ldyBDaGFubmVsKCdFVkVOVF9DSEFOTkVMJyk7XG4vKipcbiAqIEVtaXR0ZWQgd2hlbiB0aGUgYXBwbGljYXRpb24gZ2FpbnMgZm9jdXMuXG4gKi9cbmZ1bmN0aW9uIG9uUmVzdW1lKGxpc3RlbmVyKSB7XG4gICAgYXBwQ2hhbm5lbC5vbigncmVzdW1lJywgbGlzdGVuZXIpO1xufVxuLyoqXG4gKiBFbWl0dGVkIHdoZW4gdGhlIGFwcGxpY2F0aW9uIGxvc2VzIGZvY3VzLlxuICovXG5mdW5jdGlvbiBvblBhdXNlKGxpc3RlbmVyKSB7XG4gICAgYXBwQ2hhbm5lbC5vbigncGF1c2UnLCBsaXN0ZW5lcik7XG59XG4vKipcbiAqIFJldHVybnMgYSBwYXRoIGZvciBhIHBlci11c2VyIGFwcGxpY2F0aW9uIGRhdGEgZGlyZWN0b3J5IG9uIGVhY2ggcGxhdGZvcm0sXG4gKiB3aGVyZSBkYXRhIGNhbiBiZSByZWFkIGFuZCB3cml0dGVuLlxuICovXG5mdW5jdGlvbiBnZXREYXRhUGF0aCgpIHtcbiAgICBjb25zdCBwYXRoID0gcHJvY2Vzcy5lbnZbJ0RBVEFESVInXTtcbiAgICBpZiAoIXBhdGgpIHtcbiAgICAgICAgdGhyb3cgbmV3IEVycm9yKCdVbmFibGUgdG8gZ2V0IGEgZGlyZWN0b3J5IGZvciBwZXJzaXN0ZW50IGRhdGEgc3RvcmFnZS4nKTtcbiAgICB9XG4gICAgcmV0dXJuIHBhdGg7XG59XG5leHBvcnQgeyBDaGFubmVsTWVzc2FnZUNvZGVjLCBhcHBDaGFubmVsLCBldmVudENoYW5uZWwsIG9uUmVzdW1lLCBvblBhdXNlLCBnZXREYXRhUGF0aCB9O1xuLy8jIHNvdXJjZU1hcHBpbmdVUkw9YnJpZGdlLmpzLm1hcCIsImltcG9ydCB7IGFwcENoYW5uZWwsIGV2ZW50Q2hhbm5lbCwgb25SZXN1bWUsIG9uUGF1c2UsIGdldERhdGFQYXRoIH0gZnJvbSAnLi9icmlkZ2UnO1xuYXBwQ2hhbm5lbC5zZW5kKCdyZWFkeScpO1xuZXhwb3J0IHsgZXZlbnRDaGFubmVsIGFzIGNoYW5uZWwsIG9uUmVzdW1lLCBvblBhdXNlLCBnZXREYXRhUGF0aCB9O1xuLy8jIHNvdXJjZU1hcHBpbmdVUkw9aW5kZXguanMubWFwIl0sIm5hbWVzIjpbXSwibWFwcGluZ3MiOiI7OztBQUFPLE1BQU0sbUJBQW1CLENBQUM7QUFDakMsSUFBSSxPQUFPLFNBQVMsQ0FBQyxPQUFPLEVBQUU7QUFDOUIsUUFBUSxNQUFNLFNBQVMsR0FBRyxPQUFPLENBQUMsU0FBUztBQUMzQyxRQUFRLE1BQU0sSUFBSSxHQUFHLE9BQU8sQ0FBQyxJQUFJO0FBQ2pDLFFBQVEsTUFBTSxZQUFZLEdBQUcsSUFBSSxDQUFDLFNBQVMsQ0FBQyxJQUFJLENBQUM7QUFDakQsUUFBUSxNQUFNLElBQUksR0FBRztBQUNyQixZQUFZLFNBQVM7QUFDckIsWUFBWSxZQUFZO0FBQ3hCLFNBQVM7QUFD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

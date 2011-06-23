/* -*- mode: js2; js2-basic-offset: 4; indent-tabs-mode: nil -*- */

const DBus = imports.dbus;
const GLib = imports.gi.GLib;
const Lang = imports.lang;
const Mainloop = imports.mainloop;
const Shell = imports.gi.Shell;
const Signals = imports.signals;
const St = imports.gi.St;
const Tpl = imports.gi.TelepathyLogger;
const Tp = imports.gi.TelepathyGLib;

const History = imports.misc.history;
const Main = imports.ui.main;
const MessageTray = imports.ui.messageTray;


// See Notification.appendMessage
const SCROLLBACK_IMMEDIATE_TIME = 60; // 1 minute
const SCROLLBACK_RECENT_TIME = 15 * 60; // 15 minutes
const SCROLLBACK_RECENT_LENGTH = 20;
const SCROLLBACK_IDLE_LENGTH = 5;

// See Source._displayPendingMessages
const SCROLLBACK_HISTORY_LINES = 10;

const NotificationDirection = {
    SENT: 'chat-sent',
    RECEIVED: 'chat-received'
};

let contactFeatures = [Tp.ContactFeature.ALIAS,
                        Tp.ContactFeature.AVATAR_DATA,
                        Tp.ContactFeature.PRESENCE];

// This is GNOME Shell's implementation of the Telepathy 'Client'
// interface. Specifically, the shell is a Telepathy 'Observer', which
// lets us see messages even if they belong to another app (eg,
// Empathy).

function makeMessageFromTpMessage(tpMessage, direction) {
    let [text, flags] = tpMessage.to_text();
    return {
        messageType: tpMessage.get_message_type(),
        text: text,
        sender: tpMessage.sender.alias,
        timestamp: tpMessage.get_received_timestamp(),
        direction: direction
    };
}


function makeMessageFromTplEvent(event) {
    let sent = event.get_sender().get_entity_type() == Tpl.EntityType.SELF;
    let direction = sent ? NotificationDirection.SENT : NotificationDirection.RECEIVED;

    return {
        messageType: event.get_message_type(),
        text: event.get_message(),
        sender: event.get_sender().get_alias(),
        timestamp: event.get_timestamp(),
        direction: direction
    };
}

function Client() {
    this._init();
};

Client.prototype = {
    _init : function() {
        // channel path -> Source
        this._sources = {};

        // Set up a SimpleObserver, which will call _observeChannels whenever a
        // channel matching its filters is detected.
        // The second argument, recover, means _observeChannels will be run
        // for any existing channel as well.
        let dbus = Tp.DBusDaemon.dup();
        this._tpClient = new Shell.TpClient({ 'dbus_daemon': dbus,
                                              'name': 'GnomeShell',
                                              'uniquify-name': true })
        this._tpClient.set_observe_channels_func(
            Lang.bind(this, this._observeChannels));
        this._tpClient.set_approve_channels_func(
            Lang.bind(this, this._approveChannels));
        this._tpClient.set_handle_channels_func(
            Lang.bind(this, this._handleChannels));

        try {
            this._tpClient.register();
        } catch (e) {
            throw new Error('Couldn\'t register Telepathy client. Error: \n' + e);
        }
    },

    _observeChannels: function(observer, account, conn, channels,
                               dispatchOp, requests, context) {
        // If the self_contact doesn't have the ALIAS, make sure
        // to fetch it before trying to grab the channels.
        let self_contact = conn.get_self_contact();
        if (self_contact.has_feature(Tp.ContactFeature.ALIAS)) {
            this._finishObserveChannels(account, conn, channels, context);
        } else {
            Shell.get_self_contact_features(conn,
                                            contactFeatures,
                                            Lang.bind(this, function() {
                                                this._finishObserveChannels(account, conn, channels, context);
                                            }));
            context.delay();
        }
    },

    _finishObserveChannels: function(account, conn, channels, context) {
        let len = channels.length;
        for (let i = 0; i < len; i++) {
            let channel = channels[i];
            let [targetHandle, targetHandleType] = channel.get_handle();

            /* Only observe contact text channels */
            if ((!(channel instanceof Tp.TextChannel)) ||
               targetHandleType != Tp.HandleType.CONTACT)
               continue;

            /* Request a TpContact */
            Shell.get_tp_contacts(conn, [targetHandle],
                    contactFeatures,
                    Lang.bind(this,  function (connection, contacts, failed) {
                        if (contacts.length < 1)
                            return;

                        /* We got the TpContact */
                        this._createSource(account, conn, channel, contacts[0]);
                    }), null);
        }

        context.accept();
    },

    _createSource: function(account, conn, channel, contact) {
        if (this._sources[channel.get_object_path()])
            return;

        let source = new Source(account, conn, channel, contact, this._tpClient);

        this._sources[channel.get_object_path()] = source;
        source.connect('destroy', Lang.bind(this,
                       function() {
                           if (this._tpClient.is_handling_channel(channel)) {
                               // The chat box has been destroyed so it can't
                               // handle the channel any more.
                               channel.close_async(null);
                           }

                           delete this._sources[channel.get_object_path()];
                       }));
    },

    _handlingChannels: function(account, conn, channels) {
        let len = channels.length;
        for (let i = 0; i < len; i++) {
            let channel = channels[i];

            // We can only handle text channel, so close any other channel
            if (!(channel instanceof Tp.TextChannel)) {
                channel.close_async(null);
                continue;
            }

            if (this._tpClient.is_handling_channel(channel)) {
                // We are already handling the channel, display the source
                let source = this._sources[channel.get_object_path()];
                if (source)
                    source.notify();
            }
        }
    },

    _approveChannels: function(approver, account, conn, channels,
                               dispatchOp, context) {
        // Approve the channels right away as we are going to handle it
        dispatchOp.claim_with_async(this._tpClient,
                                    Lang.bind (this, function(dispatchOp, result) {
            try {
                dispatchOp.claim_with_finish(result);
                this._handlingChannels(account, conn, channels);
            } catch (err) {
                global.logError('Failed to Claim channel: ' + err);
            }}));

        context.accept();
    },

    _handleChannels: function(handler, account, conn, channels,
                              requests, user_action_time, context) {
        this._handlingChannels(account, conn, channels);
        context.accept();
    }
};

function Source(account, conn, channel, contact, client) {
    this._init(account, conn, channel, contact, client);
}

Source.prototype = {
    __proto__:  MessageTray.Source.prototype,

    _init: function(account, conn, channel, contact, client) {
        MessageTray.Source.prototype._init.call(this, contact.get_alias());

        this.isChat = true;

        this._account = account;
        this._contact = contact;
        this._client = client;

        this._conn = conn;
        this._channel = channel;
        this._closedId = this._channel.connect('invalidated', Lang.bind(this, this._channelClosed));

        this._notification = new Notification(this);
        this._notification.setUrgency(MessageTray.Urgency.HIGH);

        this._presence = contact.get_presence_type();

        this._sentId = this._channel.connect('message-sent', Lang.bind(this, this._messageSent));
        this._receivedId = this._channel.connect('message-received', Lang.bind(this, this._messageReceived));

        this._setSummaryIcon(this.createNotificationIcon());

        this._notifyAliasId = this._contact.connect('notify::alias', Lang.bind(this, this._updateAlias));
        this._notifyAvatarId = this._contact.connect('notify::avatar-file', Lang.bind(this, this._updateAvatarIcon));
        this._presenceChangedId = this._contact.connect('presence-changed', Lang.bind(this, this._presenceChanged));

        // Add ourselves as a source.
        Main.messageTray.add(this);
        this.pushNotification(this._notification);

        this._getLogMessages();
    },

    _updateAlias: function() {
        let oldAlias = this.title;
        this.setTitle(this._contact.get_alias());
        this._notification.appendAliasChange(oldAlias, this.title);
        this.pushNotification(this._notification);
    },

    createNotificationIcon: function() {
        this._iconBox = new St.Bin({ style_class: 'avatar-box' });
        this._iconBox._size = this.ICON_SIZE;

        this._updateAvatarIcon();

        return this._iconBox;
    },

    _updateAvatarIcon: function() {
        let textureCache = St.TextureCache.get_default();
        let file = this._contact.get_avatar_file();

        if (file) {
            let uri = file.get_uri();
            this._iconBox.child = textureCache.load_uri_async(uri, this._iconBox._size, this._iconBox._size);
        } else {
            this._iconBox.child = new St.Icon({ icon_name: 'avatar-default',
                                                icon_type: St.IconType.FULLCOLOR,
                                                icon_size: this._iconBox._size });
        }
    },

    open: function(notification) {
          if (this._client.is_handling_channel(this._channel)) {
              // We are handling the channel, try to pass it to Empathy
              this._client.delegate_channels_async([this._channel], global.get_current_time(), "", null);
          }
          else {
              // We are not the handler, just ask to present the channel
              let dbus = Tp.DBusDaemon.dup();
              let cd = Tp.ChannelDispatcher.new(dbus);

              cd.present_channel_async(this._channel, global.get_current_time(), null);
          }
    },

    _getLogMessages: function() {
        let logManager = Tpl.LogManager.dup_singleton();
        let entity = Tpl.Entity.new_from_tp_contact(this._contact, Tpl.EntityType.CONTACT);
        Shell.get_contact_events(logManager,
                                 this._account, entity,
                                 SCROLLBACK_HISTORY_LINES,
                                 Lang.bind(this, this._displayPendingMessages));
    },

    _displayPendingMessages: function(logManager, result) {
        let [success, events] = logManager.get_filtered_events_finish(result);

        let logMessages = events.map(makeMessageFromTplEvent);

        let pendingTpMessages = this._channel.get_pending_messages();
        let pendingMessages = [];

        for (let i = 0; i < pendingTpMessages.length; i++) {
            let message = pendingTpMessages[i];

            if (message.get_message_type() == Tp.ChannelTextMessageType.DELIVERY_REPORT)
                continue;

            pendingMessages.push(makeMessageFromTpMessage(message, NotificationDirection.RECEIVED));
        }

        let showTimestamp = false;

        for (let i = 0; i < logMessages.length; i++) {
            let logMessage = logMessages[i];
            let isPending = false;

            // Skip any log messages that are also in pendingMessages
            for (let j = 0; j < pendingMessages.length; j++) {
                let pending = pendingMessages[j];
                if (logMessage.timestamp == pending.timestamp && logMessage.text == pending.text) {
                    isPending = true;
                    break;
                }
            }

            if (!isPending) {
                showTimestamp = true;
                this._notification.appendMessage(logMessage, true, ['chat-log-message']);
            }
        }

        if (showTimestamp)
            this._notification.appendTimestamp();

        for (let i = 0; i < pendingMessages.length; i++)
            this._notification.appendMessage(pendingMessages[i], true);

        if (pendingMessages.length > 0)
            this.notify();
    },

    _channelClosed: function() {
        this._channel.disconnect(this._closedId);
        this._channel.disconnect(this._receivedId);
        this._channel.disconnect(this._sentId);

        this._contact.disconnect(this._notifyAliasId);
        this._contact.disconnect(this._notifyAvatarId);
        this._contact.disconnect(this._presenceChangedId);

        this.destroy();
    },

    _messageReceived: function(channel, message) {
        if (message.get_message_type() == Tp.ChannelTextMessageType.DELIVERY_REPORT)
            return;

        message = makeMessageFromTpMessage(message, NotificationDirection.RECEIVED);
        this._notification.appendMessage(message);
        this.notify();
    },

    // This is called for both messages we send from
    // our client and other clients as well.
    _messageSent: function(channel, message, flags, token) {
        message = makeMessageFromTpMessage(message, NotificationDirection.SENT);
        this._notification.appendMessage(message);
    },

    notify: function() {
        MessageTray.Source.prototype.notify.call(this, this._notification);
    },

    respond: function(text) {
        let type;
        if (text.slice(0, 4) == '/me ') {
            type = Tp.ChannelTextMessageType.ACTION;
            text = text.slice(4);
        } else {
            type = Tp.ChannelTextMessageType.NORMAL;
        }

        let msg = Tp.ClientMessage.new_text(type, text);
        this._channel.send_message_async(msg, 0, null);
    },

    _presenceChanged: function (contact, presence, status, message) {
        let msg, shouldNotify, title;

        if (this._presence == presence)
          return;

        title = GLib.markup_escape_text(this.title, -1);

        if (presence == Tp.ConnectionPresenceType.AVAILABLE) {
            msg = _("%s is online.").format(title);
            shouldNotify = (this._presence == Tp.ConnectionPresenceType.OFFLINE);
        } else if (presence == Tp.ConnectionPresenceType.OFFLINE ||
                   presence == Tp.ConnectionPresenceType.EXTENDED_AWAY) {
            presence = Tp.ConnectionPresenceType.OFFLINE;
            msg = _("%s is offline.").format(title);
            shouldNotify = (this._presence != Tp.ConnectionPresenceType.OFFLINE);
        } else if (presence == Tp.ConnectionPresenceType.AWAY) {
            msg = _("%s is away.").format(title);
            shouldNotify = false;
        } else if (presence == Tp.ConnectionPresenceType.BUSY) {
            msg = _("%s is busy.").format(title);
            shouldNotify = false;
        } else
            return;

        this._presence = presence;

        if (message)
            msg += ' <i>(' + GLib.markup_escape_text(message, -1) + ')</i>';

        this._notification.appendPresence(msg, shouldNotify);
        if (shouldNotify)
            this.notify();
    }
};

function Notification(source) {
    this._init(source);
}

Notification.prototype = {
    __proto__:  MessageTray.Notification.prototype,

    _init: function(source) {
        MessageTray.Notification.prototype._init.call(this, source, source.title, null, { customContent: true });
        this.setResident(true);

        this._responseEntry = new St.Entry({ style_class: 'chat-response',
                                             can_focus: true });
        this._responseEntry.clutter_text.connect('activate', Lang.bind(this, this._onEntryActivated));
        this.setActionArea(this._responseEntry);

        this._oldMaxScrollAdjustment = 0;
        this._createScrollArea();

        this._scrollArea.vscroll.adjustment.connect('changed', Lang.bind(this, function(adjustment) {
            let currentValue = adjustment.value + adjustment.page_size;
            if (currentValue == this._oldMaxScrollAdjustment)
                this.scrollTo(St.Side.BOTTOM);
            this._oldMaxScrollAdjustment = adjustment.upper;
        }));

        this._inputHistory = new History.HistoryManager({ entry: this._responseEntry.clutter_text });

        this._history = [];
        this._timestampTimeoutId = 0;
    },

    /**
     * appendMessage:
     * @message: An object with the properties:
     *   text: the body of the message,
     *   messageType: a #Tp.ChannelTextMessageType,
     *   sender: the name of the sender,
     *   timestamp: the time the message was sent
     *   direction: a #NotificationDirection
     * 
     * @noTimestamp: Whether to add a timestamp. If %true, no timestamp
     *   will be added, regardless of the difference since the
     *   last timestamp
     * @styles: A list of CSS class names.
     */
    appendMessage: function(message, noTimestamp, styles) {
        let messageBody = GLib.markup_escape_text(message.text, -1);
        styles = styles || [];
        styles.push(message.direction);

        if (message.messageType == Tp.ChannelTextMessageType.ACTION) {
            let senderAlias = GLib.markup_escape_text(message.sender, -1);
            messageBody = '<i>%s</i> %s'.format(senderAlias, messageBody);
            styles.push('chat-action');
        }

        if (message.direction == NotificationDirection.RECEIVED) {
            this.update(this.source.title, messageBody, { customContent: true,
                                                          bannerMarkup: true });
        }

        this._append(messageBody, styles, message.timestamp, noTimestamp);
    },

    _filterMessages: function() {
        if (this._history.length < 1)
            return;

        let lastMessageTime = this._history[0].time;
        let currentTime = (Date.now() / 1000);

        // Keep the scrollback from growing too long. If the most
        // recent message (before the one we just added) is within
        // SCROLLBACK_RECENT_TIME, we will keep
        // SCROLLBACK_RECENT_LENGTH previous messages. Otherwise
        // we'll keep SCROLLBACK_IDLE_LENGTH messages.

        let maxLength = (lastMessageTime < currentTime - SCROLLBACK_RECENT_TIME) ?
            SCROLLBACK_IDLE_LENGTH : SCROLLBACK_RECENT_LENGTH;

        let filteredHistory = this._history.filter(function(item) { return item.realMessage });
        if (filteredHistory.length > maxLength) {
            let lastMessageToKeep = filteredHistory[maxLength];
            let expired = this._history.splice(this._history.indexOf(lastMessageToKeep));
            for (let i = 0; i < expired.length; i++)
                expired[i].actor.destroy();
        }
    },

    _append: function(text, styles, timestamp, noTimestamp) {
        let currentTime = (Date.now() / 1000);
        if (!timestamp)
            timestamp = currentTime;

        // Reset the old message timeout
        if (this._timestampTimeoutId)
            Mainloop.source_remove(this._timestampTimeoutId);

        let body = this.addBody(text, true);
        for (let i = 0; i < styles.length; i ++)
            body.add_style_class_name(styles[i]);

        this._history.unshift({ actor: body, time: timestamp, realMessage: true });

        if (!noTimestamp) {
            if (timestamp < currentTime - SCROLLBACK_IMMEDIATE_TIME)
                this.appendTimestamp();
            else
                // Schedule a new timestamp in SCROLLBACK_IMMEDIATE_TIME
                // from the timestamp of the message.
                this._timestampTimeoutId = Mainloop.timeout_add_seconds(
                    SCROLLBACK_IMMEDIATE_TIME - (currentTime - timestamp),
                    Lang.bind(this, this.appendTimestamp));
        }

        this._filterMessages();
    },

    _formatTimestamp: function(date) {
        let now = new Date();

        var daysAgo = (now.getTime() - date.getTime()) / (24 * 60 * 60 * 1000);

        let format;

        // Show a week day and time if date is in the last week
        if (daysAgo < 1 || (daysAgo < 7 && now.getDay() != date.getDay())) {
            /* Translators: this is a time format string followed by a date.
             If applicable, replace %X with a strftime format valid for your
             locale, without seconds. */
            // xgettext:no-c-format
            format = _("Sent at %X on %A");

        // FIXME: The next two are stolen from calendar.js with the comment to avoid
        // a string-freeze break. They should be replaced with better strings
        // with 'Sent at', appropriate context and appropriate translator comment.

        } else if (date.getYear() == now.getYear()) {
            /* Translators: Shown on calendar heading when selected day occurs on current year */
            format = C_("calendar heading", "%A, %B %d");
        } else {
            /* Translators: Shown on calendar heading when selected day occurs on different year */
            format = C_("calendar heading", "%A, %B %d, %Y");
        }

        return date.toLocaleFormat(format);
    },

    appendTimestamp: function() {
        let lastMessageTime = this._history[0].time;
        let lastMessageDate = new Date(lastMessageTime * 1000);

        let timeLabel = this.addBody(this._formatTimestamp(lastMessageDate), false, { expand: true, x_fill: false, x_align: St.Align.END });
        timeLabel.add_style_class_name('chat-meta-message');
        this._history.unshift({ actor: timeLabel, time: lastMessageTime, realMessage: false });

        this._timestampTimeoutId = 0;

        this._filterMessages();

        return false;
    },

    appendPresence: function(text, asTitle) {
        if (asTitle)
            this.update(text, null, { customContent: true, titleMarkup: true });
        else
            this.update(this.source.title, null, { customContent: true });
        let label = this.addBody(text, true);
        label.add_style_class_name('chat-meta-message');
        this._history.unshift({ actor: label, time: (Date.now() / 1000), realMessage: false});

        this._filterMessages();
    },

    appendAliasChange: function(oldAlias, newAlias) {
        oldAlias = GLib.markup_escape_text(oldAlias, -1);
        newAlias = GLib.markup_escape_text(newAlias, -1);

        /* Translators: this is the other person changing their old IM name to their new
           IM name. */
        let message = '<i>' + _("%s is now known as %s").format(oldAlias, newAlias) + '</i>';
        let label = this.addBody(message, true);
        label.add_style_class_name('chat-meta-message');
        this._history.unshift({ actor: label, time: (Date.now() / 1000), realMessage: false });
        this.update(newAlias, null, { customContent: true });

        this._filterMessages();
    },

    _onEntryActivated: function() {
        let text = this._responseEntry.get_text();
        if (text == '')
            return;

        this._inputHistory.addItem(text);

        // Telepathy sends out the Sent signal for us.
        // see Source._messageSent
        this._responseEntry.set_text('');
        this.source.respond(text);
    }
};

import AsyncStorage from '@react-native-async-storage/async-storage';
import { Audio, InterruptionModeIOS } from 'expo-av';
import * as Notifications from 'expo-notifications';
import { StatusBar } from 'expo-status-bar';
import { useCallback, useEffect, useRef, useState } from 'react';
import {
  Modal,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';

const STORAGE_HOUR = '@reason/alarmHour';
const STORAGE_MINUTE = '@reason/alarmMinute';
const STORAGE_MESSAGE = '@reason/message';
const STORAGE_CONFIGURED = '@reason/configured';
const STORAGE_PERMISSION_ASKED = '@reason/permissionAsked';
const STORAGE_BACKGROUND = '@reason/background';
const ALARM_CHANNEL_ID = 'alarm';
const ALARM_KIND = 'alarm';

const alarmSound = require('./assets/alarm.wav');

Notifications.setNotificationHandler({
  handleNotification: async () => ({
    shouldShowBanner: false,
    shouldShowList: false,
    shouldPlaySound: false,
    shouldSetBadge: false,
  }),
});

function pad2(n: number) {
  return n.toString().padStart(2, '0');
}

/** 1–12 + AM/PM → 0–23 */
function to24Hour(hour12: number, isPm: boolean): number {
  if (hour12 === 12) return isPm ? 12 : 0;
  return isPm ? hour12 + 12 : hour12;
}

/** 0–23 → 1–12 + AM/PM */
function from24Hour(hour24: number): { hour12: number; isPm: boolean } {
  const isPm = hour24 >= 12;
  const h = hour24 % 12;
  const hour12 = h === 0 ? 12 : h;
  return { hour12, isPm };
}

function parseReason(data: Record<string, unknown> | undefined): string {
  if (!data || typeof data.reason !== 'string') return '';
  return data.reason;
}

async function ensureAndroidChannel() {
  if (Platform.OS !== 'android') return;
  await Notifications.setNotificationChannelAsync(ALARM_CHANNEL_ID, {
    name: 'Alarm',
    importance: Notifications.AndroidImportance.HIGH,
    vibrationPattern: [0, 400, 200, 400],
    enableVibrate: true,
    sound: 'alarm.wav',
  });
}

async function scheduleDailyAlarm(hour: number, minute: number, reason: string) {
  await ensureAndroidChannel();
  await Notifications.cancelAllScheduledNotificationsAsync();
  const text = reason.trim() || 'Your alarm';
  await Notifications.scheduleNotificationAsync({
    content: {
      title: 'Time to wake up',
      body: text,
      sound: 'alarm.wav',
      priority: Notifications.AndroidNotificationPriority.HIGH,
      data: { kind: ALARM_KIND, reason: text },
    },
    trigger: {
      type: Notifications.SchedulableTriggerInputTypes.DAILY,
      hour,
      minute,
      channelId: ALARM_CHANNEL_ID,
    },
  });
}

type BackgroundPref = 'white' | 'black';

export default function App() {
  const [backgroundPref, setBackgroundPref] = useState<BackgroundPref>('white');
  const isDark = backgroundPref === 'black';
  const theme = isDark ? colors.plainBlack : colors.plainWhite;

  const [hour12, setHour12] = useState(7);
  const [isPm, setIsPm] = useState(false);
  const [minute, setMinute] = useState(0);
  const [message, setMessage] = useState('');
  const [hydrated, setHydrated] = useState(false);
  const [permission, setPermission] = useState<Notifications.PermissionStatus | null>(null);
  const [saveStatus, setSaveStatus] = useState<string | null>(null);
  const [alarmVisible, setAlarmVisible] = useState(false);
  const [alarmReason, setAlarmReason] = useState('');

  const soundRef = useRef<Audio.Sound | null>(null);

  const stopAlarmSound = useCallback(async () => {
    const s = soundRef.current;
    if (s) {
      try {
        await s.stopAsync();
        await s.unloadAsync();
      } catch {
        /* ignore */
      }
      soundRef.current = null;
    }
  }, []);

  const playAlarmSound = useCallback(async () => {
    await stopAlarmSound();
    await Audio.setAudioModeAsync({
      allowsRecordingIOS: false,
      playsInSilentModeIOS: true,
      staysActiveInBackground: false,
      interruptionModeIOS: InterruptionModeIOS.DoNotMix,
      shouldDuckAndroid: false,
      playThroughEarpieceAndroid: false,
    });
    const { sound } = await Audio.Sound.createAsync(alarmSound, {
      isLooping: true,
      shouldPlay: true,
      volume: 1,
    });
    soundRef.current = sound;
  }, [stopAlarmSound]);

  const openAlarm = useCallback(
    async (reason: string) => {
      setAlarmReason(reason);
      setAlarmVisible(true);
      if (Platform.OS !== 'web') await playAlarmSound();
    },
    [playAlarmSound]
  );

  const dismissAlarm = useCallback(async () => {
    setAlarmVisible(false);
    setAlarmReason('');
    await stopAlarmSound();
  }, [stopAlarmSound]);

  useEffect(() => {
    return () => {
      void stopAlarmSound();
    };
  }, [stopAlarmSound]);

  useEffect(() => {
    let cancelled = false;

    (async () => {
      await ensureAndroidChannel();

      const [h, m, msg, asked, configured, bgRaw] = await Promise.all([
        AsyncStorage.getItem(STORAGE_HOUR),
        AsyncStorage.getItem(STORAGE_MINUTE),
        AsyncStorage.getItem(STORAGE_MESSAGE),
        AsyncStorage.getItem(STORAGE_PERMISSION_ASKED),
        AsyncStorage.getItem(STORAGE_CONFIGURED),
        AsyncStorage.getItem(STORAGE_BACKGROUND),
      ]);

      if (cancelled) return;

      if (bgRaw === 'black' || bgRaw === 'white') {
        setBackgroundPref(bgRaw);
      }

      let loadedHour24 = 7;
      let loadedMinute = 0;
      let loadedMsg = '';

      if (h !== null) {
        const parsed = parseInt(h, 10);
        if (!Number.isNaN(parsed) && parsed >= 0 && parsed <= 23) loadedHour24 = parsed;
      }
      if (m !== null) {
        const parsed = parseInt(m, 10);
        if (!Number.isNaN(parsed) && parsed >= 0 && parsed <= 59) loadedMinute = parsed;
      }
      if (msg !== null) loadedMsg = msg;

      const { hour12: h12, isPm: pm } = from24Hour(loadedHour24);
      setHour12(h12);
      setIsPm(pm);
      setMinute(loadedMinute);
      setMessage(loadedMsg);

      const perm = await Notifications.getPermissionsAsync();
      if (cancelled) return;
      setPermission(perm.status);

      if (asked !== '1') {
        await AsyncStorage.setItem(STORAGE_PERMISSION_ASKED, '1');
        if (perm.status !== 'granted' && Platform.OS !== 'web') {
          const req = await Notifications.requestPermissionsAsync();
          if (!cancelled) setPermission(req.status);
        }
      }

      const effectivePerm = await Notifications.getPermissionsAsync();
      if (
        !cancelled &&
        configured === '1' &&
        Platform.OS !== 'web' &&
        effectivePerm.status === 'granted'
      ) {
        try {
          await scheduleDailyAlarm(loadedHour24, loadedMinute, loadedMsg);
        } catch {
          /* scheduling can fail on simulators or misconfigured builds */
        }
      }

      setHydrated(true);
    })();

    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (Platform.OS === 'web') return;

    const subReceive = Notifications.addNotificationReceivedListener((n) => {
      const data = n.request.content.data as Record<string, unknown> | undefined;
      if (data?.kind !== ALARM_KIND) return;
      void openAlarm(parseReason(data));
    });

    const subResponse = Notifications.addNotificationResponseReceivedListener((r) => {
      const data = r.notification.request.content.data as Record<string, unknown> | undefined;
      if (data?.kind !== ALARM_KIND) return;
      void openAlarm(parseReason(data));
    });

    return () => {
      subReceive.remove();
      subResponse.remove();
    };
  }, [openAlarm]);

  useEffect(() => {
    if (Platform.OS === 'web' || !hydrated) return;

    (async () => {
      const last = await Notifications.getLastNotificationResponseAsync();
      if (!last) return;
      const data = last.notification.request.content.data as Record<string, unknown> | undefined;
      if (data?.kind !== ALARM_KIND) return;
      Notifications.clearLastNotificationResponse();
      void openAlarm(parseReason(data));
    })();
  }, [hydrated, openAlarm]);

  const bumpHour12 = (delta: number) => {
    setHour12((h) => {
      let n = h + delta;
      while (n < 1) n += 12;
      while (n > 12) n -= 12;
      return n;
    });
  };

  const bumpMinute = (delta: number) => {
    setMinute((m) => (m + delta + 60) % 60);
  };

  const setBackgroundChoice = async (pref: BackgroundPref) => {
    setBackgroundPref(pref);
    await AsyncStorage.setItem(STORAGE_BACKGROUND, pref);
  };

  const toggleBackground = () => {
    void setBackgroundChoice(isDark ? 'white' : 'black');
  };

  const saveAlarm = async () => {
    setSaveStatus(null);
    if (Platform.OS === 'web') {
      setSaveStatus('Alarms need a device build (iOS or Android), not web.');
      return;
    }

    const permNow = await Notifications.getPermissionsAsync();
    setPermission(permNow.status);
    if (permNow.status !== 'granted') {
      const req = await Notifications.requestPermissionsAsync();
      setPermission(req.status);
      if (req.status !== 'granted') {
        setSaveStatus('Notification permission is required to ring the alarm.');
        return;
      }
    }

    await ensureAndroidChannel();
    const hour24 = to24Hour(hour12, isPm);
    await AsyncStorage.multiSet([
      [STORAGE_HOUR, String(hour24)],
      [STORAGE_MINUTE, String(minute)],
      [STORAGE_MESSAGE, message],
      [STORAGE_CONFIGURED, '1'],
    ]);

    await scheduleDailyAlarm(hour24, minute, message);

    setSaveStatus('Alarm saved. Repeats every day at this time.');
  };

  if (!hydrated) {
    return (
      <View style={[styles.centered, { backgroundColor: theme.bg }]}>
        <StatusBar style={isDark ? 'light' : 'dark'} />
        <Text style={[styles.muted, { color: theme.muted }]}>Loading…</Text>
      </View>
    );
  }

  return (
    <View style={[styles.root, { backgroundColor: theme.bg }]}>
      <StatusBar style={isDark ? 'light' : 'dark'} />

      <ScrollView
        contentContainerStyle={styles.scroll}
        keyboardShouldPersistTaps="handled"
        keyboardDismissMode="on-drag"
      >
        <View style={styles.headerRow}>
          <Text style={[styles.title, { color: theme.text }]}>Reason</Text>
          <Pressable
            onPress={toggleBackground}
            accessibilityRole="switch"
            accessibilityState={{ checked: isDark }}
            style={({ pressed }) => [
              styles.themeToggle,
              {
                borderColor: theme.border,
                backgroundColor: theme.card,
                justifyContent: isDark ? 'flex-end' : 'flex-start',
              },
              pressed && styles.pressed,
            ]}
          >
            <View
              style={[
                styles.themeKnob,
                { backgroundColor: theme.text, borderColor: theme.border },
              ]}
            >
              <Text style={[styles.themeIcon, { color: theme.bg }]}>{isDark ? '☾' : '☀'}</Text>
            </View>
          </Pressable>
        </View>
        <Text style={[styles.subtitle, { color: theme.muted }]}>
          One daily alarm. Your message shows full screen when it fires.
        </Text>

        {Platform.OS === 'web' ? (
          <Text style={[styles.note, { color: theme.warn }]}>
            Run on iOS or Android (Expo Go or a dev build). Notifications are not supported on web.
          </Text>
        ) : null}

        {permission === 'denied' ? (
          <Text style={[styles.note, { color: theme.warn }]}>
            Notifications are off in system settings. Enable them to hear the alarm when the app is
            in the background.
          </Text>
        ) : null}

        <Text style={[styles.label, { color: theme.muted }]}>Alarm time</Text>
        <View style={styles.timeRow}>
          <View style={styles.timeBlock}>
            <Pressable
              onPress={() => bumpHour12(1)}
              style={({ pressed }) => [
                styles.stepper,
                { borderColor: theme.border, backgroundColor: theme.card },
                pressed && styles.pressed,
              ]}
            >
              <Text style={[styles.stepperText, { color: theme.text }]}>+</Text>
            </Pressable>
            <Text style={[styles.timeDigits, { color: theme.text }]}>{hour12}</Text>
            <Pressable
              onPress={() => bumpHour12(-1)}
              style={({ pressed }) => [
                styles.stepper,
                { borderColor: theme.border, backgroundColor: theme.card },
                pressed && styles.pressed,
              ]}
            >
              <Text style={[styles.stepperText, { color: theme.text }]}>−</Text>
            </Pressable>
          </View>
          <Text style={[styles.colon, { color: theme.text }]}>:</Text>
          <View style={styles.timeBlock}>
            <Pressable
              onPress={() => bumpMinute(1)}
              style={({ pressed }) => [
                styles.stepper,
                { borderColor: theme.border, backgroundColor: theme.card },
                pressed && styles.pressed,
              ]}
            >
              <Text style={[styles.stepperText, { color: theme.text }]}>+</Text>
            </Pressable>
            <Text style={[styles.timeDigits, { color: theme.text }]}>{pad2(minute)}</Text>
            <Pressable
              onPress={() => bumpMinute(-1)}
              style={({ pressed }) => [
                styles.stepper,
                { borderColor: theme.border, backgroundColor: theme.card },
                pressed && styles.pressed,
              ]}
            >
              <Text style={[styles.stepperText, { color: theme.text }]}>−</Text>
            </Pressable>
          </View>
          <View style={styles.ampmBlock}>
            <Pressable
              onPress={() => setIsPm(false)}
              style={({ pressed }) => [
                styles.ampmBtn,
                { borderColor: theme.border, backgroundColor: theme.card },
                !isPm && { backgroundColor: theme.text, borderColor: theme.text },
                pressed && styles.pressed,
              ]}
            >
              <Text
                style={[
                  styles.ampmText,
                  { color: theme.text },
                  !isPm && { color: theme.bg },
                ]}
              >
                AM
              </Text>
            </Pressable>
            <Pressable
              onPress={() => setIsPm(true)}
              style={({ pressed }) => [
                styles.ampmBtn,
                { borderColor: theme.border, backgroundColor: theme.card },
                isPm && { backgroundColor: theme.text, borderColor: theme.text },
                pressed && styles.pressed,
              ]}
            >
              <Text
                style={[
                  styles.ampmText,
                  { color: theme.text },
                  isPm && { color: theme.bg },
                ]}
              >
                PM
              </Text>
            </Pressable>
          </View>
        </View>

        <Text style={[styles.label, { color: theme.muted }]}>Reason to wake up</Text>
        <TextInput
          value={message}
          onChangeText={setMessage}
          placeholder="Why get out of bed?"
          placeholderTextColor={theme.placeholder}
          multiline
          style={[
            styles.input,
            { color: theme.text, borderColor: theme.border, backgroundColor: theme.card },
          ]}
        />

        <Pressable
          onPress={() => void saveAlarm()}
          style={({ pressed }) => [
            styles.saveBtn,
            { backgroundColor: theme.accent },
            pressed && styles.pressed,
          ]}
        >
          <Text style={[styles.saveBtnText, { color: isDark ? '#000000' : '#FFFFFF' }]}>
            Save alarm
          </Text>
        </Pressable>

        {saveStatus ? <Text style={[styles.status, { color: theme.muted }]}>{saveStatus}</Text> : null}

        <Text style={[styles.footnote, { color: theme.muted }]}>
          iOS may limit background work; the alarm uses a short bundled sound (under 30 seconds) for
          reliable delivery. With the app open, you also get audio playback here.
        </Text>
      </ScrollView>

      <Modal visible={alarmVisible} animationType="none" presentationStyle="fullScreen">
        <View style={[styles.alarmRoot, { backgroundColor: theme.bg }]}>
          <Text style={[styles.alarmLabel, { color: theme.muted }]}>Today's reason</Text>
          <Text style={[styles.alarmMessage, { color: theme.text }]}>
            {alarmReason || 'Wake up.'}
          </Text>
          <Pressable
            onPress={() => void dismissAlarm()}
            style={({ pressed }) => [
              styles.dismissBtn,
              { borderColor: theme.text },
              pressed && styles.pressed,
            ]}
          >
            <Text style={[styles.dismissText, { color: theme.text }]}>Dismiss</Text>
          </Pressable>
        </View>
      </Modal>
    </View>
  );
}

const colors = {
  plainWhite: {
    bg: '#FFFFFF',
    text: '#1A1A1A',
    muted: '#5C5C5C',
    warn: '#8B4513',
    border: '#E0E0E0',
    card: '#F5F5F5',
    placeholder: '#999999',
    accent: '#2D2D2D',
  },
  plainBlack: {
    bg: '#000000',
    text: '#FFFFFF',
    muted: '#B0B0B0',
    warn: '#E8B86D',
    border: '#333333',
    card: '#1A1A1A',
    placeholder: '#777777',
    accent: '#E8E8E8',
  },
};

const styles = StyleSheet.create({
  root: { flex: 1 },
  centered: { flex: 1, alignItems: 'center', justifyContent: 'center' },
  scroll: {
    paddingHorizontal: 28,
    paddingTop: 56,
    paddingBottom: 40,
  },
  title: {
    fontSize: 34,
    fontWeight: '600',
    letterSpacing: -0.5,
  },
  headerRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  themeToggle: {
    width: 68,
    height: 36,
    borderWidth: 1,
    borderRadius: 999,
    paddingHorizontal: 3,
    alignItems: 'center',
    flexDirection: 'row',
  },
  themeKnob: {
    width: 28,
    height: 28,
    borderRadius: 14,
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: 1,
  },
  themeIcon: {
    fontSize: 14,
    fontWeight: '700',
    marginTop: -1,
  },
  subtitle: {
    marginTop: 10,
    fontSize: 17,
    lineHeight: 24,
  },
  note: {
    marginTop: 20,
    fontSize: 15,
    lineHeight: 22,
  },
  label: {
    marginTop: 36,
    fontSize: 14,
    textTransform: 'uppercase',
    letterSpacing: 1,
  },
  timeRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    flexWrap: 'wrap',
    marginTop: 20,
    gap: 12,
  },
  timeBlock: { alignItems: 'center', minWidth: 100 },
  ampmBlock: {
    flexDirection: 'column',
    justifyContent: 'center',
    gap: 8,
    marginLeft: 4,
    minWidth: 72,
  },
  ampmBtn: {
    paddingVertical: 10,
    paddingHorizontal: 14,
    borderRadius: 10,
    borderWidth: 1,
    alignItems: 'center',
  },
  ampmText: { fontSize: 18, fontWeight: '600', letterSpacing: 0.5 },
  stepper: {
    width: 56,
    height: 48,
    borderRadius: 12,
    borderWidth: 1,
    alignItems: 'center',
    justifyContent: 'center',
  },
  stepperText: { fontSize: 26, fontWeight: '500' },
  timeDigits: { fontSize: 52, fontWeight: '500', marginVertical: 12, fontVariant: ['tabular-nums'] },
  colon: { fontSize: 48, fontWeight: '300', marginBottom: 8 },
  input: {
    marginTop: 12,
    minHeight: 120,
    borderWidth: 1,
    borderRadius: 14,
    padding: 18,
    fontSize: 18,
    lineHeight: 26,
    textAlignVertical: 'top',
  },
  saveBtn: {
    marginTop: 32,
    paddingVertical: 18,
    borderRadius: 14,
    alignItems: 'center',
  },
  saveBtnText: { color: '#FFFFFF', fontSize: 18, fontWeight: '600' },
  status: { marginTop: 16, fontSize: 15, lineHeight: 22 },
  footnote: { marginTop: 40, fontSize: 13, lineHeight: 20 },
  pressed: { opacity: 0.85 },
  muted: { fontSize: 16 },
  alarmRoot: {
    flex: 1,
    justifyContent: 'center',
    paddingHorizontal: 32,
  },
  alarmLabel: {
    fontSize: 15,
    textTransform: 'uppercase',
    letterSpacing: 1,
    marginBottom: 16,
  },
  alarmMessage: {
    fontSize: 28,
    lineHeight: 38,
    fontWeight: '500',
  },
  dismissBtn: {
    marginTop: 48,
    alignSelf: 'flex-start',
    paddingVertical: 16,
    paddingHorizontal: 28,
    borderRadius: 14,
    borderWidth: 2,
  },
  dismissText: { fontSize: 18, fontWeight: '600' },
});

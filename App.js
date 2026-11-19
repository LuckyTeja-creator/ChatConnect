import React, { useEffect, useMemo, useState } from "react";
import {
  SafeAreaView, View, Text, TextInput, TouchableOpacity, FlatList,
  StyleSheet, StatusBar, KeyboardAvoidingView, Platform, Alert, ActivityIndicator
} from "react-native";
import * as SQLite from "expo-sqlite";
import * as Network from "expo-network";
import { initializeApp, getApps } from "firebase/app";
import {
  getAuth, initializeAuth, getReactNativePersistence,
  onAuthStateChanged, createUserWithEmailAndPassword, signInWithEmailAndPassword,
  signOut
} from "firebase/auth";
import AsyncStorage from "@react-native-async-storage/async-storage";
import {
  getFirestore, collection, addDoc, query, orderBy, onSnapshot,
  serverTimestamp, doc, setDoc
} from "firebase/firestore";

// Add your Firebase Web App configuration in firebaseConfig.js before testing real accounts.
import { firebaseConfig } from "./firebaseConfig";

const COLORS = {
  bg: "#090D18", panel: "#121A2B", panel2: "#1A2540",
  blue: "#4F8CFF", violet: "#9067FF", text: "#F4F6FF",
  muted: "#9AA7C2", green: "#42D6A4", line: "#26324D"
};

const app = getApps().length ? getApps()[0] : initializeApp(firebaseConfig);
let auth;
try {
  auth = initializeAuth(app, { persistence: getReactNativePersistence(AsyncStorage) });
} catch {
  auth = getAuth(app);
}
const cloud = getFirestore(app);
const dbPromise = SQLite.openDatabaseAsync("chatconnect.db");

async function setupLocalDb() {
  const db = await dbPromise;
  await db.execAsync(`
    PRAGMA journal_mode = WAL;
    CREATE TABLE IF NOT EXISTS messages (
      id TEXT PRIMARY KEY NOT NULL,
      chat_id TEXT NOT NULL,
      sender_id TEXT NOT NULL,
      sender_name TEXT NOT NULL,
      body TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending'
    );
    CREATE TABLE IF NOT EXISTS outbox (
      id TEXT PRIMARY KEY NOT NULL,
      chat_id TEXT NOT NULL,
      sender_id TEXT NOT NULL,
      sender_name TEXT NOT NULL,
      body TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      attempts INTEGER NOT NULL DEFAULT 0
    );
  `);
  return db;
}
const makeId = () => `${Date.now()}-${Math.random().toString(36).slice(2, 11)}`;

export default function App() {
  const [db, setDb] = useState(null);
  const [user, setUser] = useState(null);
  const [authReady, setAuthReady] = useState(false);
  const [online, setOnline] = useState(false);
  const [messages, setMessages] = useState([]);
  const [draft, setDraft] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [mode, setMode] = useState("login");
  const [busy, setBusy] = useState(false);
  const [tab, setTab] = useState("chats");

  async function loadLocal(database, uid) {
    const rows = await database.getAllAsync(
      "SELECT * FROM messages WHERE chat_id = ? ORDER BY created_at ASC",
      ["lobby"]
    );
    setMessages(rows);
  }

  async function receiveCloudMessage(database, item) {
    const localId = item.id;
    await database.runAsync(
      `INSERT OR IGNORE INTO messages (id, chat_id, sender_id, sender_name, body, created_at, status)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [localId, "lobby", item.senderId || "", item.senderName || "User",
       item.body || "", item.createdAt?.toMillis?.() || Date.now(), "sent"]
    );
  }

  async function syncOutbox(database, currentUser) {
    if (!currentUser) return;
    const net = await Network.getNetworkStateAsync();
    if (!net.isConnected || net.isInternetReachable === false) return;
    const pending = await database.getAllAsync("SELECT * FROM outbox ORDER BY created_at ASC");
    for (const item of pending) {
      try {
        // Firestore document ID is the local ID, so retries do not create duplicates.
        await setDoc(doc(cloud, "chats", item.chat_id, "messages", item.id), {
          senderId: item.sender_id,
          senderName: item.sender_name,
          body: item.body,
          createdAt: serverTimestamp()
        });
        await database.runAsync("UPDATE messages SET status = 'sent' WHERE id = ?", [item.id]);
        await database.runAsync("DELETE FROM outbox WHERE id = ?", [item.id]);
      } catch (e) {
        await database.runAsync("UPDATE outbox SET attempts = attempts + 1 WHERE id = ?", [item.id]);
        break;
      }
    }
    await loadLocal(database, currentUser.uid);
  }

  useEffect(() => {
    let alive = true;
    let timer;
    (async () => {
      try {
        const database = await setupLocalDb();
        if (!alive) return;
        setDb(database);
        const net = await Network.getNetworkStateAsync();
        setOnline(Boolean(net.isConnected && net.isInternetReachable !== false));
        timer = setInterval(async () => {
          const state = await Network.getNetworkStateAsync();
          const connected = Boolean(state.isConnected && state.isInternetReachable !== false);
          if (alive) setOnline(connected);
          if (connected && user) await syncOutbox(database, user);
        }, 5000);
      } catch {
        Alert.alert("Storage error", "Could not open local message storage.");
      }
    })();
    const unsubscribe = onAuthStateChanged(auth, (current) => {
      if (alive) {
        setUser(current);
        setAuthReady(true);
      }
    });
    return () => {
      alive = false;
      if (timer) clearInterval(timer);
      unsubscribe();
    };
  }, [user?.uid]);

  useEffect(() => {
    if (!db || !user) return;
    let unsubscribe;
    (async () => {
      await loadLocal(db, user.uid);
      const net = await Network.getNetworkStateAsync();
      if (!net.isConnected || net.isInternetReachable === false) return;
      const q = query(collection(cloud, "chats", "lobby", "messages"), orderBy("createdAt", "asc"));
      unsubscribe = onSnapshot(q, async (snapshot) => {
        for (const change of snapshot.docChanges()) {
          const d = change.doc;
          await receiveCloudMessage(db, { id: d.id, ...d.data() });
        }
        await loadLocal(db, user.uid);
      }, () => {});
      await syncOutbox(db, user);
    })();
    return () => { if (unsubscribe) unsubscribe(); };
  }, [db, user?.uid]);

  async function submitAuth() {
    if (!email.trim() || !password) {
      Alert.alert("Missing details", "Enter your email and password.");
      return;
    }
    setBusy(true);
    try {
      if (mode === "signup") {
        const result = await createUserWithEmailAndPassword(auth, email.trim(), password);
        await setDoc(doc(cloud, "users", result.user.uid), {
          displayName: displayName.trim() || email.split("@")[0],
          email: email.trim(),
          createdAt: serverTimestamp()
        });
      } else {
        await signInWithEmailAndPassword(auth, email.trim(), password);
      }
    } catch (e) {
      Alert.alert("Account error", e.message || "Could not sign in.");
    } finally {
      setBusy(false);
    }
  }

  async function sendMessage() {
    const body = draft.trim();
    if (!body || !db || !user) return;
    const id = makeId();
    const name = user.email?.split("@")[0] || "You";
    const now = Date.now();
    await db.runAsync(
      "INSERT INTO messages (id, chat_id, sender_id, sender_name, body, created_at, status) VALUES (?, ?, ?, ?, ?, ?, ?)",
      [id, "lobby", user.uid, name, body, now, "pending"]
    );
    await db.runAsync(
      "INSERT INTO outbox (id, chat_id, sender_id, sender_name, body, created_at) VALUES (?, ?, ?, ?, ?, ?)",
      [id, "lobby", user.uid, name, body, now]
    );
    setDraft("");
    await loadLocal(db, user.uid);
    await syncOutbox(db, user);
  }

  const pendingCount = useMemo(() => messages.filter(m => m.status === "pending").length, [messages]);

  if (!authReady || !db) {
    return <SafeAreaView style={styles.safe}><ActivityIndicator color={COLORS.blue} style={{ flex: 1 }} /></SafeAreaView>;
  }

  if (!user) {
    return (
      <SafeAreaView style={styles.safe}>
        <StatusBar barStyle="light-content" backgroundColor={COLORS.bg} />
        <View style={styles.authWrap}>
          <View style={styles.brandMark}><Text style={styles.brandMarkText}>C</Text></View>
          <Text style={styles.brand}>ChatConnect</Text>
          <Text style={styles.tagline}>Connect anytime. Chat anywhere.</Text>
          <Text style={styles.authTitle}>{mode === "login" ? "Welcome back" : "Create your account"}</Text>
          {mode === "signup" && <TextInput value={displayName} onChangeText={setDisplayName} placeholder="Your name" placeholderTextColor={COLORS.muted} style={styles.authInput} />}
          <TextInput value={email} onChangeText={setEmail} autoCapitalize="none" keyboardType="email-address" placeholder="Email address" placeholderTextColor={COLORS.muted} style={styles.authInput} />
          <TextInput value={password} onChangeText={setPassword} secureTextEntry placeholder="Password" placeholderTextColor={COLORS.muted} style={styles.authInput} />
          <TouchableOpacity style={styles.primaryButton} onPress={submitAuth} disabled={busy}>
            {busy ? <ActivityIndicator color="white" /> : <Text style={styles.primaryButtonText}>{mode === "login" ? "Sign in" : "Create account"}</Text>}
          </TouchableOpacity>
          <TouchableOpacity onPress={() => setMode(mode === "login" ? "signup" : "login")} style={{ padding: 14 }}>
            <Text style={styles.switchText}>{mode === "login" ? "New here? Create an account" : "Already registered? Sign in"}</Text>
          </TouchableOpacity>
          <Text style={styles.authNote}>Sign-in requires an internet connection. Previously loaded chats are stored on this device.</Text>
        </View>
      </SafeAreaView>
    );
  }

  const renderMessage = ({ item }) => {
    const mine = item.sender_id === user.uid;
    return (
      <View style={[styles.messageRow, mine ? styles.myRow : styles.theirRow]}>
        <View style={[styles.bubble, mine ? styles.myBubble : styles.theirBubble]}>
          {!mine && <Text style={styles.senderName}>{item.sender_name}</Text>}
          <Text style={styles.messageText}>{item.body}</Text>
          <Text style={styles.metaText}>
            {new Date(item.created_at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}
            {mine ? ` · ${item.status === "pending" ? "Pending" : "Sent"}` : ""}
          </Text>
        </View>
      </View>
    );
  };

  return (
    <SafeAreaView style={styles.safe}>
      <StatusBar barStyle="light-content" backgroundColor={COLORS.bg} />
      <View style={styles.header}>
        <View style={styles.brandMark}><Text style={styles.brandMarkText}>C</Text></View>
        <View style={{ flex: 1, marginLeft: 12 }}>
          <Text style={styles.brand}>ChatConnect</Text>
          <Text style={styles.tagline}>Connect anytime. Chat anywhere.</Text>
        </View>
        <View style={[styles.statusDot, { backgroundColor: online ? COLORS.green : "#FFB454" }]} />
      </View>
      <View style={styles.connectionBanner}>
        <View style={[styles.connectionDot, { backgroundColor: online ? COLORS.green : "#FFB454" }]} />
        <Text style={styles.connectionText}>{online ? "You're online" : "Offline · Messages saved on this device"}</Text>
        <Text style={styles.pendingText}>{pendingCount} pending</Text>
      </View>
      <View style={styles.tabs}>
        <TouchableOpacity onPress={() => setTab("chats")} style={[styles.tab, tab === "chats" && styles.activeTab]}><Text style={[styles.tabText, tab === "chats" && styles.activeTabText]}>Chats</Text></TouchableOpacity>
        <TouchableOpacity onPress={() => setTab("profile")} style={[styles.tab, tab === "profile" && styles.activeTab]}><Text style={[styles.tabText, tab === "profile" && styles.activeTabText]}>Profile</Text></TouchableOpacity>
      </View>
      {tab === "profile" ? (
        <View style={styles.profileCard}>
          <View style={styles.avatarLarge}><Text style={styles.avatarLargeText}>{(user.email?.[0] || "U").toUpperCase()}</Text></View>
          <Text style={styles.profileName}>{user.email}</Text>
          <Text style={styles.profileHint}>Your account is connected to Firebase Authentication.</Text>
          <TouchableOpacity style={styles.secondaryButton} onPress={() => signOut(auth)}><Text style={styles.primaryButtonText}>Sign out</Text></TouchableOpacity>
        </View>
      ) : (
        <>
          <View style={styles.chatHeading}><View><Text style={styles.sectionTitle}>Messages</Text><Text style={styles.sectionSubtitle}>Shared demo lobby</Text></View><View style={styles.avatar}><Text style={styles.avatarText}>C</Text></View></View>
          <FlatList style={{ flex: 1 }} contentContainerStyle={styles.messageContent} data={messages} keyExtractor={item => item.id} renderItem={renderMessage}
            ListEmptyComponent={<View style={styles.emptyState}><Text style={styles.emptyIcon}>✉</Text><Text style={styles.emptyTitle}>Start a conversation</Text><Text style={styles.emptyText}>Messages save on this device while offline and sync when you reconnect.</Text></View>} />
          <KeyboardAvoidingView behavior={Platform.OS === "ios" ? "padding" : undefined}>
            <View style={styles.composer}>
              <TextInput value={draft} onChangeText={setDraft} placeholder="Write a message..." placeholderTextColor={COLORS.muted} style={styles.input} multiline />
              <TouchableOpacity style={styles.sendButton} onPress={sendMessage} disabled={!draft.trim()}><Text style={styles.sendButtonText}>➤</Text></TouchableOpacity>
            </View>
          </KeyboardAvoidingView>
        </>
      )}
      <Text style={styles.footer}>CHATCONNECT · OFFLINE-FIRST</Text>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: COLORS.bg, paddingTop: Platform.OS === "android" ? 8 : 0 },
  header: { flexDirection: "row", alignItems: "center", paddingHorizontal: 20, paddingVertical: 14 },
  brandMark: { width: 44, height: 44, borderRadius: 15, backgroundColor: COLORS.blue, alignItems: "center", justifyContent: "center" },
  brandMarkText: { color: "white", fontSize: 26, fontWeight: "900" },
  brand: { color: COLORS.text, fontSize: 20, fontWeight: "800" },
  tagline: { color: COLORS.muted, fontSize: 11, marginTop: 2 },
  statusDot: { width: 10, height: 10, borderRadius: 5 },
  connectionBanner: { marginHorizontal: 18, padding: 11, borderRadius: 12, backgroundColor: COLORS.panel, flexDirection: "row", alignItems: "center" },
  connectionDot: { width: 7, height: 7, borderRadius: 4, marginRight: 8 },
  connectionText: { color: COLORS.muted, fontSize: 11, flex: 1 },
  pendingText: { color: "#B9A6FF", fontSize: 11, fontWeight: "700" },
  tabs: { flexDirection: "row", marginHorizontal: 18, marginTop: 17, borderBottomWidth: 1, borderColor: COLORS.line },
  tab: { paddingVertical: 11, paddingHorizontal: 16, marginRight: 8 },
  activeTab: { borderBottomWidth: 2, borderColor: COLORS.blue },
  tabText: { color: COLORS.muted, fontWeight: "600" },
  activeTabText: { color: COLORS.text },
  chatHeading: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", paddingHorizontal: 20, paddingTop: 20, paddingBottom: 12 },
  sectionTitle: { color: COLORS.text, fontSize: 25, fontWeight: "800" },
  sectionSubtitle: { color: COLORS.muted, fontSize: 11, marginTop: 4 },
  avatar: { width: 42, height: 42, borderRadius: 15, backgroundColor: "#493E83", alignItems: "center", justifyContent: "center" },
  avatarText: { color: "white", fontWeight: "800", fontSize: 17 },
  messageContent: { paddingHorizontal: 18, paddingVertical: 18, flexGrow: 1, justifyContent: "flex-end" },
  messageRow: { flexDirection: "row", marginVertical: 5 },
  myRow: { justifyContent: "flex-end" },
  theirRow: { justifyContent: "flex-start" },
  bubble: { maxWidth: "82%", paddingHorizontal: 13, paddingTop: 10, paddingBottom: 7, borderRadius: 17 },
  myBubble: { backgroundColor: "#315FB5", borderBottomRightRadius: 5 },
  theirBubble: { backgroundColor: COLORS.panel2, borderBottomLeftRadius: 5 },
  senderName: { color: "#B9A6FF", fontSize: 10, fontWeight: "700", marginBottom: 4 },
  messageText: { color: COLORS.text, fontSize: 14, lineHeight: 20 },
  metaText: { color: "#D0D9F0", fontSize: 9, textAlign: "right", marginTop: 5 },
  emptyState: { alignItems: "center", paddingHorizontal: 35, paddingVertical: 35 },
  emptyIcon: { color: COLORS.violet, fontSize: 35, marginBottom: 12 },
  emptyTitle: { color: COLORS.text, fontSize: 17, fontWeight: "700" },
  emptyText: { color: COLORS.muted, fontSize: 12, textAlign: "center", lineHeight: 18, marginTop: 7 },
  composer: { flexDirection: "row", alignItems: "center", marginHorizontal: 16, marginBottom: 12, padding: 7, borderRadius: 18, backgroundColor: COLORS.panel, borderWidth: 1, borderColor: COLORS.line },
  input: { flex: 1, color: COLORS.text, paddingHorizontal: 12, paddingVertical: 8, maxHeight: 100, fontSize: 14 },
  sendButton: { width: 42, height: 42, borderRadius: 14, backgroundColor: COLORS.blue, alignItems: "center", justifyContent: "center" },
  sendButtonText: { color: "white", fontSize: 20, fontWeight: "800" },
  profileCard: { margin: 20, padding: 22, borderRadius: 20, backgroundColor: COLORS.panel, alignItems: "center" },
  avatarLarge: { width: 76, height: 76, borderRadius: 25, backgroundColor: "#493E83", alignItems: "center", justifyContent: "center", marginBottom: 14 },
  avatarLargeText: { color: "white", fontSize: 32, fontWeight: "800" },
  profileName: { color: COLORS.text, fontSize: 16, fontWeight: "800" },
  profileHint: { color: COLORS.muted, fontSize: 12, lineHeight: 18, textAlign: "center", marginTop: 8, marginBottom: 20 },
  authWrap: { flex: 1, justifyContent: "center", padding: 26, alignItems: "center" },
  authTitle: { color: COLORS.text, fontSize: 22, fontWeight: "800", alignSelf: "flex-start", marginTop: 35, marginBottom: 16 },
  authInput: { width: "100%", backgroundColor: COLORS.panel, color: COLORS.text, borderRadius: 13, padding: 15, marginBottom: 11, borderWidth: 1, borderColor: COLORS.line },
  primaryButton: { width: "100%", padding: 16, backgroundColor: COLORS.blue, borderRadius: 14, alignItems: "center", marginTop: 5 },
  secondaryButton: { width: "100%", padding: 14, backgroundColor: COLORS.violet, borderRadius: 13, alignItems: "center", marginTop: 10 },
  primaryButtonText: { color: "white", fontWeight: "800" },
  switchText: { color: "#B9C9F4", fontSize: 12, fontWeight: "600" },
  authNote: { color: COLORS.muted, fontSize: 10, textAlign: "center", lineHeight: 16, marginTop: 20 },
  footer: { color: "#53617F", fontSize: 8, textAlign: "center", letterSpacing: 2, paddingVertical: 8 }
});

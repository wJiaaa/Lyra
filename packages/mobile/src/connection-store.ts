import { Platform } from "react-native";
import * as SecureStore from "expo-secure-store";
import { normalizeConnection, type Connection } from "@plume/client-runtime";

const KEY = "plume.desktop";
export async function readConnection(): Promise<Connection | null> {
	const raw = Platform.OS === "web" ? sessionStorage.getItem(KEY) : await SecureStore.getItemAsync(KEY);
	if (!raw) return null;
	try { const value = JSON.parse(raw); return normalizeConnection(value.url, value.token, value.relay === true); } catch { return null; }
}
export async function saveConnection(connection: Connection | null): Promise<void> {
	if (Platform.OS === "web") {
		if (connection) sessionStorage.setItem(KEY, JSON.stringify(connection)); else sessionStorage.removeItem(KEY);
	} else if (connection) await SecureStore.setItemAsync(KEY, JSON.stringify(connection));
	else await SecureStore.deleteItemAsync(KEY);
}

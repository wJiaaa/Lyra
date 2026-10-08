import { launchCameraAsync, launchImageLibraryAsync, requestCameraPermissionsAsync, type ImagePickerAsset } from "expo-image-picker";
import { ImageManipulator, SaveFormat } from "expo-image-manipulator";
import type { PromptImage } from "@plume/client-runtime";

export interface Attachment extends PromptImage { uri: string }

/** 和电脑那头 `mobile-prompt.ts` 的上限一致；多选时直接限制在系统相册里，而不是选完再丢。 */
export const MAX_IMAGES = 4;
/**
 * 长边缩到 1568：模型看图的上限就在这一带，再大它也会自己缩，多出来的只是上传时间。
 * 手机原图十几兆，经中转走公网时这一步决定了发一张图是一秒还是半分钟。
 */
const EDGE = 1568;

async function shrink(asset: ImagePickerAsset): Promise<Attachment> {
	const context = ImageManipulator.manipulate(asset.uri);
	if (Math.max(asset.width, asset.height) > EDGE) context.resize(asset.width >= asset.height ? { width: EDGE } : { height: EDGE });
	const image = await context.renderAsync();
	const saved = await image.saveAsync({ compress: 0.75, format: SaveFormat.JPEG, base64: true });
	if (!saved.base64) throw new Error("Image encoding failed");
	return { uri: saved.uri, data: saved.base64, mimeType: "image/jpeg" };
}

/** 选或拍；取消返回空数组。相机权限被拒时返回 null，由调用方说明怎么打开。 */
export async function pickImages(source: "library" | "camera", room: number): Promise<Attachment[] | null> {
	if (room <= 0) return [];
	if (source === "camera" && !(await requestCameraPermissionsAsync()).granted) return null;
	const options = { mediaTypes: ["images" as const], quality: 1, allowsMultipleSelection: source === "library" && room > 1, selectionLimit: room };
	const result = source === "camera" ? await launchCameraAsync(options) : await launchImageLibraryAsync(options);
	if (result.canceled) return [];
	return Promise.all(result.assets.slice(0, room).map(shrink));
}

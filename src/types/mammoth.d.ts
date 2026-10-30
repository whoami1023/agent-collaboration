declare module "mammoth" {
  export interface MammothMessage {
    type: string;
    message: string;
  }

  export interface MammothResult {
    value: string;
    messages: MammothMessage[];
  }

  export interface MammothInput {
    /** Node Buffer；类型写成 unknown，避免不同 @types/node 版本的 Buffer 泛型定义冲突。 */
    buffer: unknown;
  }

  export interface MammothImage {
    read(encoding?: string): Promise<string>;
    contentType: string;
    altText?: string;
  }

  interface ImageConverters {
    imgElement(transform: (image: MammothImage) => { src?: string; alt?: string }): unknown;
  }

  export interface MammothOptions {
    convertImage?: unknown;
    styleMap?: string[];
    includeDefaultStyleMap?: boolean;
  }

  export const images: ImageConverters;

  export function convertToHtml(input: MammothInput, options?: MammothOptions): Promise<MammothResult>;
  export function extractRawText(input: MammothInput): Promise<MammothResult>;
}

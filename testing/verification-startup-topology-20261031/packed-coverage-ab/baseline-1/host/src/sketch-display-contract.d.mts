import type {DesignDocument} from '../../design-client/src/model'
import type {PreviewOwner} from './sketch-preview-contract.mjs'
export type SketchDisplaySnapshot={owner:PreviewOwner;revision:number;pageId:string;document:DesignDocument;assets:Record<string,string>;warnings:string[];sourceFonts:string[];artboards:string[]}
export function admitSketchDisplay(value:unknown,owner:PreviewOwner,revision?:number):SketchDisplaySnapshot

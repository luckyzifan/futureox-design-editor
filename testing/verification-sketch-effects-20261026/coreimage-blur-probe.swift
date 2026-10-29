import Foundation
import CoreImage
import CoreGraphics
let space=CGColorSpace(name:CGColorSpace.sRGB)!
let ctx=CIContext(options:[.workingColorSpace:space,.outputColorSpace:space,.cacheIntermediates:false])
let w=256,h=192
var results:[[String:Any]]=[]
for kind in ["CIMotionBlur","CIZoomBlur"] { for r in [1.0,5.0,10.0,20.0] {
 var bytes=[UInt8](repeating:0,count:w*h*4)
 for y in 64..<128 {for x in 96..<160 {let i=(y*w+x)*4;bytes[i]=255;bytes[i+1]=255;bytes[i+2]=255;bytes[i+3]=255}}
 let source=CIImage(bitmapData:Data(bytes),bytesPerRow:w*4,size:CGSize(width:w,height:h),format:.RGBA8,colorSpace:space)
 let f=CIFilter(name:kind)!
 f.setValue(source,forKey:kCIInputImageKey)
 if kind=="CIMotionBlur" {f.setValue(r,forKey:kCIInputRadiusKey);f.setValue(0,forKey:kCIInputAngleKey)}
 else {f.setValue(r,forKey:kCIInputAmountKey);f.setValue(CIVector(x:128,y:96),forKey:kCIInputCenterKey)}
 var out=[Float](repeating:0,count:w*h*4)
 out.withUnsafeMutableBytes{ctx.render(f.outputImage!,toBitmap:$0.baseAddress!,rowBytes:w*16,bounds:CGRect(x:0,y:0,width:w,height:h),format:.RGBAf,colorSpace:space)}
 results.append(["kind":kind,"radius":r,"row":(0..<w).map{out[(96*w+$0)*4+3]},"center":out[(96*w+128)*4+3]])
}}
let json=try JSONSerialization.data(withJSONObject:results,options:[.prettyPrinted,.sortedKeys]);print(String(data:json,encoding:.utf8)!)

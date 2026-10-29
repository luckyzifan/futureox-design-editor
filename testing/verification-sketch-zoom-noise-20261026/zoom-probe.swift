import Foundation
import CoreImage
import CoreGraphics
let space=CGColorSpace(name:CGColorSpace.sRGB)!
let ctx=CIContext(options:[.workingColorSpace:space,.outputColorSpace:space,.cacheIntermediates:false])
let w=256,h=192
var rows:[[String:Any]]=[]
for amount in [1.0,5.0,10.0,20.0,40.0] { for point in [false,true] {
 var bytes=[UInt8](repeating:0,count:w*h*4)
 if point {let i=(96*w+144)*4;for c in 0..<4{bytes[i+c]=255}}
 else {for y in 64..<128 {for x in 96..<160 {let i=(y*w+x)*4;for c in 0..<4{bytes[i+c]=255}}}}
 let source=CIImage(bitmapData:Data(bytes),bytesPerRow:w*4,size:CGSize(width:w,height:h),format:.RGBA8,colorSpace:space)
 let f=CIFilter(name:"CIZoomBlur")!;f.setValue(source,forKey:kCIInputImageKey);f.setValue(amount,forKey:kCIInputAmountKey);f.setValue(CIVector(x:128,y:96),forKey:kCIInputCenterKey)
 var out=[Float](repeating:0,count:w*h*4)
 out.withUnsafeMutableBytes{ctx.render(f.outputImage!,toBitmap:$0.baseAddress!,rowBytes:w*16,bounds:CGRect(x:0,y:0,width:w,height:h),format:.RGBAf,colorSpace:space)}
 let mass=(0..<w*h).reduce(0.0){$0+Double(out[$1*4+3])}
 rows.append(["amount":amount,"point":point,"mass":mass,"row":(0..<w).map{out[(96*w+$0)*4+3]}])
}}
print(String(data:try JSONSerialization.data(withJSONObject:rows,options:[.prettyPrinted,.sortedKeys]),encoding:.utf8)!)

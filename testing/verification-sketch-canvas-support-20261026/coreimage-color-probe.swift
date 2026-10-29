import Foundation
import CoreImage
import CoreGraphics

let space = CGColorSpace(name: CGColorSpace.extendedLinearSRGB)!
let context = CIContext(options: [.workingColorSpace: space, .outputColorSpace: space,
                                 .cacheIntermediates: false])
let colors: [[Float]] = [[0,0,0,1], [1,0,0,1], [0,1,0,1], [0,0,1,1],
                        [0.2,0.4,0.7,1], [2,-0.25,0.5,1], [0.1,0.2,0.35,0.5], [0,0,0,0]]
var results: [[String:Any]] = []
for parameters in [[1.0,0.0,1.0,0.0], [0.0,0.0,1.0,0.0], [0.8,0.2,1.4,0.0],
                   [1.0,0.0,1.0,0.7], [1.0,0.0,1.0,-0.7], [1.0,0.0,1.0,Double.pi/2], [1.0,0.0,1.0,Double.pi]] {
    let data = colors.flatMap { $0 }.withUnsafeBytes { Data($0) }
    let source = CIImage(bitmapData:data, bytesPerRow:colors.count * 16,
                         size:CGSize(width:colors.count,height:1), format:.RGBAf, colorSpace:space)
    let controls = CIFilter(name:"CIColorControls", parameters:[kCIInputImageKey:source,
        kCIInputSaturationKey:parameters[0], kCIInputBrightnessKey:parameters[1], kCIInputContrastKey:parameters[2]])!
    let hue = CIFilter(name:"CIHueAdjust",parameters:[kCIInputImageKey:controls.outputImage!,kCIInputAngleKey:parameters[3]])!
    var output = [Float](repeating:0,count:colors.count * 4)
    output.withUnsafeMutableBytes {
        context.render(hue.outputImage!,toBitmap:$0.baseAddress!,rowBytes:colors.count * 16,
                       bounds:CGRect(x:0,y:0,width:colors.count,height:1),format:.RGBAf,colorSpace:space)
    }
    results.append(["parameters":parameters,"pixels":stride(from:0,to:output.count,by:4).map{Array(output[$0..<$0+4])}])
}
let json = try JSONSerialization.data(withJSONObject:["workingColorSpace":"extendedLinearSRGB","input":colors,"results":results],options:[.prettyPrinted,.sortedKeys])
print(String(data:json,encoding:.utf8)!)

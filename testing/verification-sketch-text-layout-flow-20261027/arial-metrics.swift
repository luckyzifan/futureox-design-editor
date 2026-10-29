import Foundation

import CoreText
let font=CTFontCreateWithName("ArialMT" as CFString,20,nil)
print("ascent",CTFontGetAscent(font),"descent",CTFontGetDescent(font),"leading",CTFontGetLeading(font),"cap",CTFontGetCapHeight(font),"units",CTFontGetUnitsPerEm(font))
import CoreGraphics
for height in [0.0,30.0,40.0] {
 var value=CGFloat(height)
 let style=withUnsafePointer(to:&value){ pointer in
 var settings=[CTParagraphStyleSetting(spec:.minimumLineHeight,valueSize:MemoryLayout<CGFloat>.size,value:pointer),CTParagraphStyleSetting(spec:.maximumLineHeight,valueSize:MemoryLayout<CGFloat>.size,value:pointer)]
 return CTParagraphStyleCreate(&settings,settings.count)
 }
 let s=NSAttributedString(string:"Hello",attributes:[NSAttributedString.Key(kCTFontAttributeName as String):font,NSAttributedString.Key(kCTParagraphStyleAttributeName as String):style])
 let fs=CTFramesetterCreateWithAttributedString(s)
 let frame=CTFramesetterCreateFrame(fs,CFRange(location:0,length:0),CGPath(rect:CGRect(x:0,y:0,width:200,height:140),transform:nil),nil)
 var origins=[CGPoint](repeating:.zero,count:1);CTFrameGetLineOrigins(frame,CFRange(location:0,length:1),&origins)
 print(height,origins, "baseline",140-origins[0].y)
}

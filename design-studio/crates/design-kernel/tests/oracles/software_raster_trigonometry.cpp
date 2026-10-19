/**************************************************************************
 *
 * Copyright 2009-2010 VMware, Inc.
 * All Rights Reserved.
 *
 * Permission is hereby granted, free of charge, to any person obtaining a
 * copy of this software and associated documentation files (the
 * "Software"), to deal in the Software without restriction, including
 * without limitation the rights to use, copy, modify, merge, publish,
 * distribute, sub license, and/or sell copies of the Software, and to
 * permit persons to whom the Software is furnished to do so, subject to
 * the following conditions:
 *
 * The above copyright notice and this permission notice (including the
 * next paragraph) shall be included in all copies or substantial portions
 * of the Software.
 *
 * THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS
 * OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF
 * MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NON-INFRINGEMENT.
 * IN NO EVENT SHALL VMWARE AND/OR ITS SUPPLIERS BE LIABLE FOR
 * ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT,
 * TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE
 * SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.
 *
 **************************************************************************/
// Independent C++ oracle for software_raster::trigonometry.
// Formula: Mesa 26.1.0 src/gallium/auxiliary/gallivm/lp_bld_arit.c,
// lp_build_sin_or_cos. Do not use a production Rust output to refresh digests.
// Build with clang++ -std=c++17 -O2 -ffp-contract=off.
// Input is little-endian u32 float bits; each output is three little-endian u32:
// (0, sin bits, cos bits), (1, canonical NaN, canonical NaN), or (2, 0, 0).
// The nonfinite status deliberately ignores NaN payloads. Status 2 identifies
// finite arguments outside the source FPToSI reduction's defined i32 domain.
#include <cmath>
#include <cstdint>
#include <cstring>
#include <fstream>
#include <iostream>
static float fma32(float a,float b,float c){return std::fma(a,b,c);}
static uint32_t bits(float v){uint32_t b;std::memcpy(&b,&v,4);return b;}
static float value(uint32_t b){float v;std::memcpy(&v,&b,4);return v;}
static uint32_t oracle(float input,bool cosine){
 float x=std::fabs(input),scaled=x*float(1.27323954473516);
 int i=static_cast<int>(scaled),j=(i+1)&~1;float y=float(j);
 x=fma32(y,float(-.78515625),x);x=fma32(y,float(-2.4187564849853515625e-4),x);x=fma32(y,float(-3.77489497744594108e-8),x);
 float z=x*x;
 float c=fma32(z,float(2.443315711809948E-5),float(-1.388731625493765E-3));c=fma32(c,z,float(4.166664568298827E-2));c*=z;c*=z;float half=z*.5f;c-=half;c+=1.f;
 float s=fma32(z,float(-1.9515295891E-4),float(8.3321608736E-3));s=fma32(s,z,float(-1.6666654611E-1));s*=z;s=fma32(s,x,x);
 int select=cosine?j-2:j;uint32_t sign=cosine?(uint32_t(~select)&4)<<29:((bits(input)&0x80000000)^((uint32_t(i+1)&4)<<29));
 float r=value(bits((select&2)?c:s)^sign);if(r< -1.f)r=-1.f;if(r>1.f)r=1.f;return bits(r);
}
int main(int argc,char**argv){std::ifstream in(argv[1],std::ios::binary);std::ofstream out(argv[2],std::ios::binary);uint32_t u;while(in.read((char*)&u,4)){float v=value(u);uint32_t rec[3];if(!std::isfinite(v)){rec[0]=1;rec[1]=rec[2]=0x7fc00000;}else if(!std::isfinite(std::fabs(v)*float(1.27323954473516))||std::fabs(v)*float(1.27323954473516)>=2147483648.f){rec[0]=2;rec[1]=rec[2]=0;}else{rec[0]=0;rec[1]=oracle(v,false);rec[2]=oracle(v,true);}out.write((char*)rec,12);}return 0;}

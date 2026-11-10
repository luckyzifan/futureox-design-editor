#!/bin/sh
# Rebuild the linux-x64 ffmpeg binary from the tarballs in ./sources.
# This script does not download. It needs gcc, make, nasm, pkg-config, and zlib.
set -eu
root=$(CDPATH= cd -- "$(dirname "$0")" && pwd)
src=$root/sources
work=${FUTUREOX_FFMPEG_WORK:-/tmp/futureox-ffmpeg-rebuild}
prefix=$work/prefix
jobs=${FUTUREOX_FFMPEG_JOBS:-2}
out=${1:-$root/ffmpeg}
rm -rf "$work"
mkdir -p "$prefix" "$(dirname "$out")"
tar -xzf "$src/x264-b35605ace3ddf7c1a5d67a2eb553f034aef41d55.tar.gz" -C "$work"
tar -xzf "$src/libvpx-1.15.2.tar.gz" -C "$work"
tar -xzf "$src/ffmpeg-n7.0.2.tar.gz" -C "$work"

(
  cd "$work"/x264-*
  ./configure \
    --prefix="$prefix" \
    --enable-static \
    --enable-pic \
    --disable-cli \
    --disable-shared \
    --bit-depth=8 \
    --chroma-format=420
  make -j"$jobs"
  make install
)

(
  cd "$work"/libvpx-*
  ./configure \
    --prefix="$prefix" \
    --disable-shared \
    --enable-static \
    --enable-pic \
    --disable-examples \
    --disable-tools \
    --disable-unit-tests \
    --disable-docs \
    --as=nasm
  make -j"$jobs"
  make install
)

(
  cd "$work"/FFmpeg-*
  PKG_CONFIG_PATH="$prefix/lib/pkgconfig${PKG_CONFIG_PATH:+:$PKG_CONFIG_PATH}" \
    ./configure \
      --prefix="$prefix" \
      --pkg-config-flags=--static \
      --extra-cflags="-I$prefix/include" \
      --extra-ldflags="-L$prefix/lib" \
      --extra-libs="-lpthread -lm -ldl" \
      --disable-shared \
      --enable-static \
      --enable-gpl \
      --enable-version3 \
      --disable-debug \
      --disable-doc \
      --disable-ffplay \
      --disable-ffprobe \
      --disable-network \
      --disable-autodetect \
      --enable-zlib \
      --enable-libx264 \
      --enable-libvpx \
      --disable-encoders --enable-encoder=libx264,libvpx_vp9 \
      --disable-decoders --enable-decoder=png \
      --disable-muxers --enable-muxer=mp4,mov,webm,matroska \
      --disable-demuxers --enable-demuxer=image2 \
      --disable-parsers --enable-parser=png,h264,vp9 \
      --disable-protocols --enable-protocol=file \
      --disable-filters --enable-filter=pad,scale,format \
      --disable-bsfs --enable-bsf=vp9_superframe,extract_extradata,h264_mp4toannexb
  make -j"$jobs"
  cp -f ffmpeg "$out"
)
chmod 755 "$out"
"$out" -version

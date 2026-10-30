#!/bin/bash
# GPU 使用率监控脚本 - 用于 macOS Activity Monitor 验证
# 监测 Electron 应用的 GPU 历史记录曲线

echo "🎯 GPU 使用率监控 - 设计应用"
echo "================================"
echo ""
echo "📊 监测目标："
echo "  1. 放大/缩小时 GPU 使用率变化"
echo "  2. 瓦片重渲染频率"
echo "  3. 动态密度切换是否触发"
echo ""
echo "🔧 使用方法："
echo "  1. 打开活动监视器 (Activity Monitor)"
echo "  2. 选择 '窗口' > 'GPU 历史记录'"
echo "  3. 运行此脚本并操作应用"
echo "  4. 观察 GPU 使用率曲线"
echo ""

# 查找 Electron 进程
ELECTRON_PID=$(pgrep -f "design-desktop.*Electron" | head -1)

if [ -z "$ELECTRON_PID" ]; then
  echo "❌ 未找到 Electron 进程"
  echo "   请先启动应用："
  echo "   cd frontend/design-desktop && bun run dev"
  exit 1
fi

echo "✅ 找到 Electron 进程: PID $ELECTRON_PID"
echo ""
echo "📈 开始监控 GPU 使用率..."
echo "   (按 Ctrl+C 停止)"
echo ""

# 持续监控
while true; do
  # 获取进程的 GPU 时间（需要 sudo）
  GPU_TIME=$(sudo powermetrics --samplers gpu_power -i 1000 -n 1 2>/dev/null | \
    grep -A 10 "Device Total GPU Time" | \
    grep "ms" | \
    awk '{sum+=$1} END {print sum}')

  TIMESTAMP=$(date +"%H:%M:%S")

  if [ -n "$GPU_TIME" ]; then
    printf "[%s] GPU 时间: %.2f ms\n" "$TIMESTAMP" "$GPU_TIME"
  else
    # fallback：显示进程内存和 CPU
    MEM=$(ps -p $ELECTRON_PID -o rss= | awk '{printf "%.1f", $1/1024}')
    CPU=$(ps -p $ELECTRON_PID -o %cpu= | awk '{printf "%.1f", $1}')
    printf "[%s] 内存: %s MB | CPU: %s%%\n" "$TIMESTAMP" "$MEM" "$CPU"
  fi

  sleep 1
done

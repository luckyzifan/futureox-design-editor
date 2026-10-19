#!/bin/bash

echo "=== Checking for Electron logs ==="
echo ""

# Check macOS logs
echo "1. Recent Electron console logs (last 50 lines):"
log show --predicate 'process == "Electron"' --last 5m --style compact 2>/dev/null | tail -50

echo ""
echo "2. Check for imageLevel logs:"
log show --predicate 'eventMessage CONTAINS "imageLevel"' --last 10m 2>/dev/null | tail -20

echo ""
echo "3. Check for Image Pixel Check logs:"
log show --predicate 'eventMessage CONTAINS "Image Pixel Check"' --last 10m 2>/dev/null | tail -20

echo ""
echo "=== If no logs found, please: ==="
echo "1. Run: cd frontend/design-desktop && bun run dev"
echo "2. Open the app and zoom to 3200%"
echo "3. Press Cmd+Option+I to open DevTools"
echo "4. Paste the Console output here"

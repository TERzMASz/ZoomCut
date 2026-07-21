#!/bin/zsh
# ดับเบิลคลิกเพื่อเปิด ZoomCut — แล้วกดปุ่ม "🔴 อัด iPhone" ในหน้าเว็บได้เลย
cd "$(dirname "$0")"
echo "🎬 ZoomCut"
echo "══════════"
python3 serve.py
echo ""
echo "กด Enter เพื่อปิดหน้าต่างนี้..."
read

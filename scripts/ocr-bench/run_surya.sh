#!/bin/bash
# usage: run_surya.sh <variant_dir_with_pngs> <outdir>   (2 cores, CPU only; each page its own run so time/memory are per page)
V=$1; O=$2; mkdir -p $O; export TORCH_DEVICE=cpu OMP_NUM_THREADS=2 MKL_NUM_THREADS=2
pip show surya-ocr > $O/version.txt 2>&1; cat $O/version.txt | head -3
surya_ocr --help 2>&1 | head -40
nproc; lscpu | grep -E "Model name|Flags" | cut -c1-200
run() { # name, dir
  /usr/bin/time -v -o $O/time_$1.txt timeout ${PAGE_TIMEOUT:-1500} taskset -c 0,1 surya_ocr $2 --output_dir $O/res_$1 > $O/log_$1.txt 2>&1; echo "== $1 exit $?"; tail -n 6 $O/log_$1.txt | cut -c1-300
}
mkdir -p $O/blank && python -c "from PIL import Image; Image.new('RGB',(300,120),'white').save('$O/blank/blank.png')"
run blank $O/blank
for f in $V/*.png; do b=$(basename $f .png); mkdir -p $O/in_$b; cp $f $O/in_$b/; run $b $O/in_$b; done
find $O -name "results*.json" | head -20

#!/bin/bash
# usage: run_surya.sh <variant_dir_with_pngs> <outdir>   (2 cores only, CPU only, peak memory and CPU time measured)
set -x
V=$1; O=$2; mkdir -p $O/one $O/all; export TORCH_DEVICE=cpu OMP_NUM_THREADS=2 MKL_NUM_THREADS=2
pip show surya-ocr | head -3 | tee $O/version.txt
mkdir -p $O/single; cp "$(ls $V/*.png | head -1)" $O/single/
/usr/bin/time -v -o $O/time_one.txt taskset -c 0,1 surya_ocr $O/single --output_dir $O/one > $O/log_one.txt 2>&1
/usr/bin/time -v -o $O/time_all.txt taskset -c 0,1 surya_ocr $V --output_dir $O/all > $O/log_all.txt 2>&1
tail -5 $O/log_one.txt $O/log_all.txt; find $O/all -maxdepth 2 | head

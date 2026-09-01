#!/bin/zsh
# Pull every /api/analytics/export/* route into ~/Downloads/Outcomes, sorted
# into the three folders the tabs are named after.
#
# Written as a script rather than a run of ad-hoc curls so the bundle can be
# regenerated after a data refresh without anyone reconstructing 30 URLs and
# their query strings from memory. Each line records the exact filters the
# file was produced under, which is the part that is impossible to recover
# from the CSV afterwards.
#
# A route that legitimately has nothing to say answers 404 with a JSON reason
# (e.g. "no grids miss Primary care at 60 km"). That is a FINDING, so the
# reason is kept as a .txt beside the folder rather than the file silently
# going missing.

set -u
# Set explicitly: this runs from a non-interactive shell whose PATH does not
# reliably include /usr/bin, and the failure mode is silent — every curl
# "not found", every file written 0 bytes, and the run still exits 0.
export PATH="/usr/bin:/bin:/usr/sbin:/sbin:$PATH"
BASE="http://localhost:5050/api/analytics/export"
OUT="$HOME/Downloads/Outcomes"
Y="year=2025"

mkdir -p "$OUT/proximity" "$OUT/gap" "$OUT/ambulance" "$OUT/reference"
: > "$OUT/_download_log.txt"

# NOTE the parameter name. It must NOT be `path`: zsh ties the scalar $path to
# the $PATH array, so `local path="$3"` silently replaces PATH with a URL for
# the rest of the function. Every command then fails "not found", curl never
# runs, and each file is written 0 bytes while the script still exits 0.
get() {  # get <folder> <filename> <route+query>
  local folder="$1" name="$2" route="$3"
  local dest="$OUT/$folder/$name"
  local code size
  code=$(curl -s -o "$dest" -w "%{http_code}" "$BASE/$route")
  size=$(stat -f%z "$dest" 2>/dev/null || echo 0)
  if [[ "$code" != "200" ]]; then
    # Keep the server's reason. A 404 here usually means "nothing qualifies",
    # which is an answer, not a failure.
    mv "$dest" "${dest%.*}_EMPTY_REASON.txt"
  fi
  printf '%-5s %-52s %10s  %s\n' "$code" "$name" "$size" "$route" >> "$OUT/_download_log.txt"
  printf '%-5s %-50s %10s bytes\n' "$code" "$name" "$size"
}

echo "=== PROXIMITY ==="
get proximity grid_verdicts_all_levels.csv          "proximity-verdicts.csv?$Y"
get proximity facilities_master_list.csv            "proximity-facilities.csv?$Y"
get proximity hospital_to_grid_every_pair.csv       "hospital-grids.csv?$Y&per_level=1"
get proximity grid_to_nearest_hospitals.csv         "proximity.csv?$Y&private=1"
get proximity level_reach_out_of_reach.csv          "level-reach.csv?$Y&which=out_reach&mode=complement"
get proximity level_reach_in_reach.csv              "level-reach.csv?$Y&which=in_reach&mode=complement"
get proximity EVERYTHING_proximity_tab.zip          "proximity-bundle.zip?$Y&split_district=0"
get proximity EVERYTHING_proximity_tab_by_district.zip "proximity-bundle.zip?$Y&split_district=1"
get proximity hospital_to_grid_bundle_by_district.zip  "hospital-grids-bundle.zip?$Y&per_level=1"

echo "=== GAP ==="
get gap EVERYTHING_gaps_tab.zip                     "gaps-bundle.zip?$Y&split_district=0"
get gap EVERYTHING_gaps_tab_by_district.zip         "gaps-bundle.zip?$Y&split_district=1"
# The tier routes default to a uniform 60 km, at which Haryana has NO strict
# gap at all — every grid reaches some public tertiary/secondary/primary
# facility within 60 km. The 60 km call is kept so that result is on the
# record, and a 10 km call is added beside it because that is the threshold at
# which the tier question actually separates districts.
get gap gaps_by_district_at_60km.csv                "gaps-districts.csv?$Y"
get gap gaps_by_district_at_10km.csv                "gaps-districts.csv?$Y&threshold=10"
get gap tier_gaps_strict_at_60km.csv                "tier-gaps.csv?$Y&mode=strict"
get gap tier_gaps_strict_at_10km.csv                "tier-gaps.csv?$Y&mode=strict&threshold=10"
get gap tier_gaps_per_tier_bundle_60km.zip          "tier-gaps-bundle.zip?$Y"
get gap tier_gaps_per_tier_bundle_10km.zip          "tier-gaps-bundle.zip?$Y&threshold=10"
get gap coverage_gaps_distance_mode.csv             "gaps.csv?$Y&mode=distance"
get gap coverage_gaps_time_mode.csv                 "gaps.csv?$Y&mode=time"
get gap grids_with_no_hospital_within_60km.csv      "uncovered-grids.csv?$Y"
get gap type_reach_out_of_reach.csv                 "type-reach.csv?$Y&which=out_reach"
# The per-level gap files also live inside EVERYTHING_gaps_tab.zip. Repeated
# here as loose CSVs because these four are the ones people actually open, and
# "which grids have no L2" should not require unzipping anything.
get gap level_L1_not_covered_60km.csv               "level-reach.csv?$Y&which=out_reach&levels=L1"
get gap level_L2_not_covered_30km.csv               "level-reach.csv?$Y&which=out_reach&levels=L2"
get gap level_L3_not_covered_10km.csv               "level-reach.csv?$Y&which=out_reach&levels=L3"
get gap level_EP_no_private_within_60km.csv         "level-reach.csv?$Y&which=out_reach&levels=EP"

echo "=== AMBULANCE ==="
get ambulance old_fleet_out_of_reach_grids.csv      "ambulance-gaps.csv?$Y&threshold=10&emergency_only=0"
get ambulance old_fleet_emergency_only_gaps.csv     "ambulance-gaps.csv?$Y&threshold=10&emergency_only=1"
get ambulance EVERYTHING_ambulance_OLD_fleet.zip    "ambulance-bundle.zip?$Y&threshold=10&dataset=old&split_district=0"
get ambulance EVERYTHING_ambulance_OLD_by_district.zip "ambulance-bundle.zip?$Y&threshold=10&dataset=old&split_district=1"
get ambulance new_workbook_out_of_reach_grids.csv   "ambulance-v2-gaps.csv?$Y&threshold_km=10"
get ambulance new_workbook_stations.csv             "ambulance-v2-stations.csv?$Y"
get ambulance new_workbook_gaps_by_district.csv     "ambulance-v2-districts.csv?$Y&threshold_km=10"
get ambulance EVERYTHING_ambulance_NEW_workbook.zip "ambulance-bundle.zip?$Y&threshold_km=10&dataset=new&split_district=0"
get ambulance EVERYTHING_ambulance_NEW_by_district.zip "ambulance-bundle.zip?$Y&threshold_km=10&dataset=new&split_district=1"

echo "=== REFERENCE (not tab-specific) ==="
get reference blood_banks.csv                       "bloodbanks.csv?$Y"
get reference district_severity_tss.csv             "district-tss.csv?$Y"

echo
echo "log written to $OUT/_download_log.txt"

package main

import (
	"fmt"
	"slices"
	"strings"
	"tailscale.com/feature/featuretags"
)

func main() {
	keep := map[featuretags.FeatureTag]bool{}
	for dep := range featuretags.Requires("netstack") {
		keep[dep] = true
	}
	var tags []string
	for feature := range featuretags.Features {
		if feature != "" && feature.IsOmittable() && !keep[feature] {
			tags = append(tags, feature.OmitTag())
		}
	}
	slices.Sort(tags)
	fmt.Println(strings.Join(tags, ","))
}

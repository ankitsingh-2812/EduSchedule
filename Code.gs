/**
 * 1. Web App Doorway
 */
function doGet(e) {
  return HtmlService.createHtmlOutputFromFile('Index')
    .setTitle('Smart Timetable Pro - Multi-Agent Engine')
    .addMetaTag('viewport', 'width=device-width, initial-scale=1')
    .setXFrameOptionsMode(HtmlService.XFrameOptionsMode.ALLOWALL);
}

// Global parsing utility to safely read faculties out of a task element
function getFaculties(task) {
  if (!task) return [];
  if (Array.isArray(task.faculties)) return task.faculties;
  
  let facs = [];
  if (task.faculty) facs.push(...task.faculty.split(/[/&]/).map(f=>f.trim()));
  if (task.facultyG1) facs.push(...task.facultyG1.split(/[/&]/).map(f=>f.trim()));
  if (task.facultyG2) facs.push(...task.facultyG2.split(/[/&]/).map(f=>f.trim()));
  return [...new Set(facs.filter(f => f))]; 
}

// 1-to-1 parsing setup matching parallel ID strings with parallel Name arrays
function parseMultipleFaculties(facIdStr, facNameStr) {
  facIdStr = (facIdStr || "").toString().trim();
  facNameStr = (facNameStr || "").toString().trim();
  if (!facNameStr) return ["Unknown Faculty"];
  
  let ids = facIdStr.split(/[/&]/).map(s => s.trim()).filter(s => s);
  let names = facNameStr.split(/[/&]/).map(s => s.trim()).filter(s => s);
  let result = [];
  
  if (ids.length === names.length && ids.length > 0) {
    for (let i = 0; i < names.length; i++) {
      result.push(`${ids[i]} - ${names[i]}`);
    }
  } else {
    names.forEach(name => {
      if (facIdStr && ids.length === 1) {
        result.push(`${ids[0]} - ${name}`);
      } else {
        result.push(name);
      }
    });
  }
  return result;
}

/**
 * 2. Advanced Constraint Satisfaction & Co-Scheduling Engine
 */
function generateSchedule(loadData, config, lockedData = []) {
  try {
    const days = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday'];
    const slots = 9; 
    const timeSlots = [
      '9:30 - 10:20', '10:20 - 11:10', '11:10 - 12:00', '12:00 - 12:50', 
      '12:50 - 01:35', '01:35 - 02:20', '02:20 - 03:05', '03:05 - 03:50', '03:50 - 04:35'
    ];

    let baseTasks = standardizeTasks(loadData, config);
    if(baseTasks.length === 0) return { success: false, message: "Parsed 0 valid classes. Check Excel headers." };

    let tId = 1;
    baseTasks.forEach(t => { t.id = "T" + (tId++); t.placed = false; t.locked = false; });

    config.batches = [...new Set(baseTasks.flatMap(t => t.batch))]; 
    config.batchesInfo = {};
    config.subjectFreq = {}; 

    baseTasks.forEach(t => { 
        t.batch.forEach(b => {
            config.batchesInfo[b] = t.sem; 
            if (t.type === 'Theory') {
                if (!config.subjectFreq[b]) config.subjectFreq[b] = {};
                config.subjectFreq[b][t.subject] = (config.subjectFreq[b][t.subject] || 0) + 1;
            }
        }); 
    });

    let facultyWeights = {}, batchWeights = {};
    baseTasks.forEach(t => {
      let weight = t.type.includes('Lab') ? 2 : 1;
      let facs = getFaculties(t);
      facs.forEach(f => { if(f) facultyWeights[f] = (facultyWeights[f] || 0) + weight; });
      t.batch.forEach(b => { batchWeights[b] = (batchWeights[b] || 0) + weight; });
    });

    let masterGrid = initializeGrid(days, slots, config);
    let facultyTracker = initializeFacultyTracker(baseTasks, days);

    // 1. PLACE LOCKED TASKS 
    lockedData.forEach(ld => {
        let task = baseTasks.find(t => t.id === ld.taskId);
        if (task) {
            task.locked = true;
            let reqSlots = task.type.includes('Lab') ? 2 : 1;
            placeTaskPerfectly(masterGrid, facultyTracker, task, ld.day, ld.startSlot, reqSlots, {loc: ld.loc, area: ld.area, loc2: ld.loc2});
            task.placed = true;
        }
    });

    // 2. CSP VARIABLE ORDERING
    let unassignedQueue = prioritizeLoadMRV(baseTasks.filter(t => !t.placed), facultyWeights, batchWeights, config);

    // 3. GREEDY INITIALIZATION (Strict constraints)
    let stillUnassigned = [];
    while (unassignedQueue.length > 0) {
        let task = unassignedQueue.shift();
        let placed = attemptPlacement(masterGrid, facultyTracker, task, days, slots, config, false);
        if (!placed) stillUnassigned.push(task);
    }

    // 4. MIN-CONFLICTS REPAIR PHASE & DESPERATION MODE
    let repairAttempts = 0, maxRepairs = 15000; 
    while (stillUnassigned.length > 0 && repairAttempts < maxRepairs) {
        let task = stillUnassigned.shift();
        
        let relaxConstraints = repairAttempts > 500; 
        
        let rawPlaced = attemptPlacement(masterGrid, facultyTracker, task, days, slots, config, relaxConstraints);
        
        if (!rawPlaced) {
            let evictionSuccessful = attemptEvictionAndRepair(masterGrid, facultyTracker, task, days, slots, config, stillUnassigned, relaxConstraints);
            
            if (!evictionSuccessful) {
                stillUnassigned.push(task); 
                if (repairAttempts % 25 === 0) stillUnassigned.sort(() => Math.random() - 0.5);
            }
        }
        repairAttempts++;
    }

    let finalUnassigned = [...new Set(stillUnassigned)].filter(t => !t.placed);

    // 5. METRICS & REPORTS
    let vacantSlotsReport = [];
    days.forEach(day => {
      for (let s = 0; s < 9; s++) {
        Object.keys(masterGrid[day][s].asRooms).forEach(room => { if (masterGrid[day][s].asRooms[room] === null) vacantSlotsReport.push({ day, time: timeSlots[s], type: 'AS Theory', name: room, dept: 'AS' }); });
        Object.keys(masterGrid[day][s].asCompHalf).forEach(room => { if (masterGrid[day][s].asCompHalf[room] === null) vacantSlotsReport.push({ day, time: timeSlots[s], type: 'AS Comp (Half)', name: room, dept: 'AS' }); });
        Object.keys(masterGrid[day][s].asPhysicsFull).forEach(room => { if (masterGrid[day][s].asPhysicsFull[room] === null) vacantSlotsReport.push({ day, time: timeSlots[s], type: 'AS Physics (Full)', name: room, dept: 'AS' }); });
        Object.keys(masterGrid[day][s].asChemFull).forEach(room => { if (masterGrid[day][s].asChemFull[room] === null) vacantSlotsReport.push({ day, time: timeSlots[s], type: 'AS Chem (Full)', name: room, dept: 'AS' }); });

        Object.keys(masterGrid[day][s].cseRooms).forEach(room => { if (masterGrid[day][s].cseRooms[room] === null) vacantSlotsReport.push({ day, time: timeSlots[s], type: 'CSE Theory', name: room, dept: 'CSE' }); });
        Object.keys(masterGrid[day][s].cseCompHalf).forEach(room => { if (masterGrid[day][s].cseCompHalf[room] === null) vacantSlotsReport.push({ day, time: timeSlots[s], type: 'CSE Comp (Half)', name: room, dept: 'CSE' }); });
        Object.keys(masterGrid[day][s].cseCompFull).forEach(room => { if (masterGrid[day][s].cseCompFull[room] === null) vacantSlotsReport.push({ day, time: timeSlots[s], type: 'CSE Comp (Full)', name: room, dept: 'CSE' }); });
        
        Object.keys(masterGrid[day][s].cseElecHalf).forEach(room => { if (masterGrid[day][s].cseElecHalf[room] === null) vacantSlotsReport.push({ day, time: timeSlots[s], type: 'CSE Elec (Half)', name: room, dept: 'CSE/ETE' }); });
        Object.keys(masterGrid[day][s].eteElec).forEach(room => { if (masterGrid[day][s].eteElec[room] === null) vacantSlotsReport.push({ day, time: timeSlots[s], type: 'ETE Elec (Shared)', name: room, dept: 'ETE/CSE' }); });
      }
    });

    let facultyByDept = {};
    baseTasks.forEach(t => {
        let dept = t.dept === 'COMBINED-EE/ETE' ? 'ETE' : t.dept;
        let facs = getFaculties(t);
        facs.forEach(f => {
            if(f) {
                if(!facultyByDept[f]) facultyByDept[f] = [];
                if(!facultyByDept[f].includes(dept)) facultyByDept[f].push(dept);
            }
        });
    });

    let isPerfect = (finalUnassigned.length === 0);
    let finalMessage = isPerfect ? `✅ Multi-Agent CSP Resolution Complete. Zero clashes detected.` : `⚠️ Hard Constraints Triggered: Failed to schedule ${finalUnassigned.length} classes due to strict combinations or limited infrastructure.`;

    return {
      success: true, isWarning: !isPerfect, overflowCount: 0,
      grid: masterGrid, unassigned: finalUnassigned, vacantSlots: vacantSlotsReport, 
      facultyWorkloads: facultyWeights, batchWorkloads: batchWeights, facultyDeptMap: facultyByDept,
      timeSlots: timeSlots, batchesInfo: config.batchesInfo, message: finalMessage
    };
  } catch(e) { return { success: false, message: "Engine Error: " + e.stack }; }
}

// ---------------- CSP AI HELPERS ----------------

function prioritizeLoadMRV(tasks, facultyWeights, batchWeights, config) {
  return tasks.sort((a, b) => {
    if (a.type === 'LabSplit' && b.type !== 'LabSplit') return -1;
    if (b.type === 'LabSplit' && a.type !== 'LabSplit') return 1;
    
    let aIsLab = a.type.includes('Lab'); let bIsLab = b.type.includes('Lab');
    if (aIsLab && !bIsLab) return -1; if (!aIsLab && bIsLab) return 1;
    
    let aBatchLoad = 0; a.batch.forEach(bat => aBatchLoad += batchWeights[bat] || 0);
    let bBatchLoad = 0; b.batch.forEach(bat => bBatchLoad += batchWeights[bat] || 0);
    if (bBatchLoad !== aBatchLoad) return bBatchLoad - aBatchLoad;

    let aFacLoad = 0; getFaculties(a).forEach(f => aFacLoad += facultyWeights[f] || 0);
    let bFacLoad = 0; getFaculties(b).forEach(f => bFacLoad += facultyWeights[f] || 0);
    if (bFacLoad !== aFacLoad) return bFacLoad - aFacLoad;

    return b.batch.length - a.batch.length;
  });
}

function attemptPlacement(grid, facTracker, task, days, slots, config, relax = false) {
    let slotsNeeded = task.type.includes('Lab') ? 2 : 1;
    let facs = getFaculties(task);
    let mainFac = facs[0];
    
    let sortedDays = [...days].sort((d1, d2) => {
        let load1 = mainFac && facTracker[mainFac] ? facTracker[mainFac][d1].totalDailyLoad : 0;
        let load2 = mainFac && facTracker[mainFac] ? facTracker[mainFac][d2].totalDailyLoad : 0;
        return load1 - load2;
    });

    for (let d = 0; d < sortedDays.length; d++) {
        for (let s = 0; s <= slots - slotsNeeded; s++) {
            let validRes = isHardValidPlacement(grid, facTracker, task, sortedDays[d], s, slotsNeeded, config, null, relax);
            if (validRes) { placeTaskPerfectly(grid, facTracker, task, sortedDays[d], s, slotsNeeded, validRes); return true; }
        }
    }
    return false;
}

function attemptEvictionAndRepair(grid, facTracker, bottleneckTask, days, slots, config, unassignedQueue, relax = false) {
    let slotsNeeded = bottleneckTask.type.includes('Lab') ? 2 : 1;
    let sDays = [...days].sort(() => Math.random() - 0.5);
    
    for (let d = 0; d < sDays.length; d++) {
        let day = sDays[d];
        for (let s = 0; s <= slots - slotsNeeded; s++) {
            let blockingTasks = getBlockingTasks(grid, facTracker, bottleneckTask, day, s, slotsNeeded);
            
            if (blockingTasks.length <= 2 && blockingTasks.every(t => !t.locked)) {
                
                blockingTasks.forEach(t => removeTask(grid, facTracker, t));
                
                let validRes = isHardValidPlacement(grid, facTracker, bottleneckTask, day, s, slotsNeeded, config, null, relax);
                
                if (validRes) {
                    placeTaskPerfectly(grid, facTracker, bottleneckTask, day, s, slotsNeeded, validRes);
                    blockingTasks.forEach(t => unassignedQueue.unshift(t));
                    return true;
                } else { 
                    blockingTasks.forEach(t => placeTaskPerfectly(grid, facTracker, t, t.startDay, t.startSlot, t.type.includes('Lab') ? 2 : 1, {loc: t.assignedLoc, area: t.assignedArea, loc2: t.assignedLoc2})); 
                }
            }
        }
    }
    return false;
}

function getBlockingTasks(grid, facTracker, task, day, startSlot, slotsNeeded) {
    let blockers = new Set();
    let facs = getFaculties(task);
    let batches = task.batch, subg = task.subgroup;
    for (let s = startSlot; s < startSlot + slotsNeeded; s++) {
        facs.forEach(f => { if(f && facTracker[f] && facTracker[f][day].slots[s]) blockers.add(facTracker[f][day].slots[s]); });
        for (let batch of batches) {
            let bState = grid[day][s].batches[batch];
            if (!bState) continue;
            if (subg === 'ALL' || task.type.includes('Split')) { 
                if (bState.ALL) blockers.add(bState.ALL); if (bState.G1) blockers.add(bState.G1); if (bState.G2) blockers.add(bState.G2); 
            } else { 
                if (bState.ALL) blockers.add(bState.ALL); if (bState[subg]) blockers.add(bState[subg]); 
            }
        }
    }
    return Array.from(blockers);
}

function removeTask(grid, facTracker, task) {
    let slotsNeeded = task.type.includes('Lab') ? 2 : 1;
    let facs = getFaculties(task);
    for(let s = task.startSlot; s < task.startSlot + slotsNeeded; s++) {
        facs.forEach(f => { if(f && facTracker[f]) { facTracker[f][task.startDay].slots[s] = null; facTracker[f][task.startDay].totalDailyLoad -= 1; } });
        task.batch.forEach(b => {
            let bState = grid[task.startDay][s].batches[b];
            if (bState) { 
                if (task.type === 'LabSplit') { bState.G1 = null; bState.G2 = null; }
                else if (task.subgroup === 'ALL') bState.ALL = null; 
                else bState[task.subgroup] = null; 
            }
        });
        grid[task.startDay][s][task.assignedArea][task.assignedLoc] = null;
        if(task.type === 'LabSplit' && task.assignedLoc2) grid[task.startDay][s][task.assignedArea][task.assignedLoc2] = null;
    }
    task.placed = false;
}

function placeTaskPerfectly(grid, facTracker, task, day, startSlot, slotsNeeded, validRes) {
  task.startDay = day; task.startSlot = startSlot;
  task.assignedLoc = validRes.loc; task.assignedArea = validRes.area;
  if(validRes.loc2) task.assignedLoc2 = validRes.loc2;
  task.placed = true;
  let facs = getFaculties(task);
  
  for(let s = startSlot; s < startSlot + slotsNeeded; s++) {
    facs.forEach(f => { if(f && facTracker[f]) { facTracker[f][day].slots[s] = task; facTracker[f][day].totalDailyLoad += 1; } });
    task.batch.forEach(b => {
        let bState = grid[day][s].batches[b];
        if (bState) { 
            if (task.type === 'LabSplit') { bState.G1 = task; bState.G2 = task; }
            else if (task.subgroup === 'ALL') bState.ALL = task; 
            else bState[task.subgroup] = task; 
        }
    });
    grid[day][s][validRes.area][validRes.loc] = task;
    if(task.type === 'LabSplit' && validRes.loc2) grid[day][s][validRes.area][validRes.loc2] = task;
  }
}

function isHardValidPlacement(grid, facTracker, task, day, startSlot, slotsNeeded, config, excludeLoc = null, relax = false) {
  let facs = getFaculties(task);
  let batches = task.batch, subg = task.subgroup;
  
  // 1. Soft Constraint: Theory Frequency
  if (task.type === 'Theory' && !relax) {
      for (let batch of batches) {
          let maxPerDay = 2; 
          let dailyCount = 0;
          for (let i = 0; i < 9; i++) {
              let bState = grid[day][i].batches[batch];
              if (bState && bState.ALL && bState.ALL.subject === task.subject) dailyCount++;
              else if (bState && bState[subg] && bState[subg].subject === task.subject) dailyCount++;
          }
          if (dailyCount >= maxPerDay) return false;
      }
  }

  // 2. Strict Constraint: Distributed Batch Lunch Preservation
  if (!relax) {
      for (let batch of batches) {
          let cSubg = (task.type === 'LabSplit') ? 'ALL' : subg;
          
          let slot3Busy = false;
          let bState3 = grid[day][3].batches[batch];
          if (bState3 && (bState3.ALL !== null || (cSubg !== 'ALL' ? bState3[cSubg] !== null : (bState3.G1 !== null || bState3.G2 !== null)))) slot3Busy = true;
          if (startSlot <= 3 && (startSlot + slotsNeeded) > 3) slot3Busy = true;
          
          let slot4Busy = false;
          let bState4 = grid[day][4].batches[batch];
          if (bState4 && (bState4.ALL !== null || (cSubg !== 'ALL' ? bState4[cSubg] !== null : (bState4.G1 !== null || bState4.G2 !== null)))) slot4Busy = true;
          if (startSlot <= 4 && (startSlot + slotsNeeded) > 4) slot4Busy = true;
          
          if (slot3Busy && slot4Busy) return false;
      }
  }

  let taskOverlapsLunch = false;
  for (let s = startSlot; s < startSlot + slotsNeeded; s++) {
      if (s === 3 || s === 4) taskOverlapsLunch = true;
  }

  // 3. Strict & Soft Faculty Checks
  for(let f of facs) {
      if(!f || !facTracker[f]) continue;
      if (!relax && facTracker[f][day].totalDailyLoad + slotsNeeded > config.maxLoad) return false;
      for (let s = startSlot; s < startSlot + slotsNeeded; s++) { if (facTracker[f][day].slots[s] !== null) return false; }
      if (!relax && taskOverlapsLunch) {
          let facSlotsAfter = [...facTracker[f][day].slots];
          for (let s = startSlot; s < startSlot + slotsNeeded; s++) facSlotsAfter[s] = task;
          if (facSlotsAfter[3] !== null && facSlotsAfter[4] !== null) return false;
      }
  }

  // 4. Strict Constraint: Batch Clash Check
  for (let s = startSlot; s < startSlot + slotsNeeded; s++) {
    for (let batch of batches) {
        let bState = grid[day][s].batches[batch];
        if (!bState) continue;
        if (task.type === 'LabSplit' || subg === 'ALL') { if (bState.ALL !== null || bState.G1 !== null || bState.G2 !== null) return false; } 
        else { if (bState.ALL !== null || bState[subg] !== null) return false; }
    }
  }

  // 5. Strict Constraint: Room Availability 
  return getAvailableResource(grid, day, startSlot, slotsNeeded, task, excludeLoc, relax);
}

function getAvailableResource(grid, day, startSlot, slotsNeeded, task, excludeLoc = null, relax = false) {
  let dept = task.dept;
  let subLower = (task.subject || "").toLowerCase();
  
  let isLabOrProject = task.type.includes('Lab') || subLower.includes('project');
  let isEE_or_ETE = (dept === 'EE' || dept === 'ETE' || dept === 'COMBINED-EE/ETE');
  
  let isDELab = isLabOrProject && (subLower.includes('de lab') || subLower.includes('digital electronics'));
  let isPhysics = isLabOrProject && subLower.includes('physics');
  let isChem = isLabOrProject && subLower.includes('chem');

  let res = null;

  // RULE 1: EE/ETE or CSE DE Labs -> STRICTLY in Electronics Labs
  if (isEE_or_ETE || isDELab) {
      let elecAreas = dept === 'CSE' ? ['cseElecHalf', 'eteElec'] : ['eteElec', 'cseElecHalf'];
      if (task.type === 'LabSplit') {
          for (let area of elecAreas) {
              res = findDualFreeIn(grid, day, startSlot, slotsNeeded, area, excludeLoc);
              if (res) return res;
          }
      } else {
          for (let area of elecAreas) {
              res = findFreeIn(grid, day, startSlot, slotsNeeded, area, excludeLoc);
              if (res) return res;
          }
      }
      return null; 
  }

  // RULE 2: Physics Labs
  if (isPhysics) {
      if (task.type === 'LabSplit') return findDualFreeIn(grid, day, startSlot, slotsNeeded, 'asPhysicsFull', excludeLoc);
      return findFreeIn(grid, day, startSlot, slotsNeeded, 'asPhysicsFull', excludeLoc); 
  }

  // RULE 3: Chemistry Labs
  if (isChem) {
      if (task.type === 'LabSplit') return findDualFreeIn(grid, day, startSlot, slotsNeeded, 'asChemFull', excludeLoc);
      return findFreeIn(grid, day, startSlot, slotsNeeded, 'asChemFull', excludeLoc); 
  }

  // RULE 4: Shared Pooling Logic
  if (isLabOrProject) {
      if (task.type === 'LabSplit') {
          let dualPool = dept === 'CSE' ? ['cseCompHalf', 'asCompHalf'] : ['asCompHalf', 'cseCompHalf'];
          for (let area of dualPool) {
              res = findDualFreeIn(grid, day, startSlot, slotsNeeded, area, excludeLoc);
              if (res) return res;
          }
      } else {
          let singlePool = dept === 'CSE' 
              ? ['cseCompHalf', 'cseCompFull', 'asCompHalf'] 
              : ['asCompHalf', 'cseCompHalf', 'cseCompFull'];
          for (let area of singlePool) {
              res = findFreeIn(grid, day, startSlot, slotsNeeded, area, excludeLoc);
              if (res) return res;
          }
      }
      return null; 
      
  } else {
      // --- THEORY POOL (Batch Locality & Min Resource Utilization) ---
      let roomPool = dept === 'CSE' ? ['cseRooms', 'asRooms'] : ['asRooms', 'cseRooms'];
      
      let locScores = {};
      task.batch.forEach(b => {
          for(let i = 0; i < 9; i++) {
              let bState = grid[day][i].batches[b];
              if (!bState) continue;
              
              let locs = [];
              if (bState.ALL && bState.ALL.assignedLoc) locs.push(bState.ALL.assignedLoc);
              if (bState.G1 && bState.G1.assignedLoc) locs.push(bState.G1.assignedLoc);
              if (bState.G2 && bState.G2.assignedLoc) locs.push(bState.G2.assignedLoc);
              
              locs.forEach(loc => {
                  if (!locScores[loc]) locScores[loc] = 0;
                  locScores[loc] += 1; 
                  if (i === startSlot - 1 || i === startSlot + slotsNeeded) {
                      locScores[loc] += 10; 
                  }
              });
          }
      });
      
      let sortedPreferred = Object.keys(locScores).sort((a,b) => locScores[b] - locScores[a]);

      for (let prefLoc of sortedPreferred) {
          if (prefLoc === excludeLoc) continue;
          for (let area of roomPool) {
              if (grid[day][startSlot][area] && grid[day][startSlot][area].hasOwnProperty(prefLoc)) {
                  let isFree = true;
                  for (let s = startSlot; s < startSlot + slotsNeeded; s++) {
                      if (grid[day][s][area][prefLoc] !== null) { isFree = false; break; }
                  }
                  if (isFree) return { loc: prefLoc, area: area };
              }
          }
      }

      for (let area of roomPool) {
          res = findFreeIn(grid, day, startSlot, slotsNeeded, area, excludeLoc);
          if (res) return res;
      }
      return null; 
  }
}

function findFreeIn(grid, day, startSlot, slotsNeeded, targetArea, excludeLoc) {
  if (!grid[day][startSlot][targetArea]) return null;
  let sortedLocs = Object.keys(grid[day][startSlot][targetArea]).sort((a,b) => (parseInt(a.replace(/\D/g, ''))||0) - (parseInt(b.replace(/\D/g, ''))||0));
  for (let loc of sortedLocs) {
    if (loc === excludeLoc) continue; 
    let isFree = true;
    for (let s = startSlot; s < startSlot + slotsNeeded; s++) { if (grid[day][s][targetArea][loc] !== null) { isFree = false; break; } }
    if (isFree) return { loc: loc, area: targetArea }; 
  }
  return null;
}

function findDualFreeIn(grid, day, startSlot, slotsNeeded, area, excludeLoc) {
  if (!grid[day][startSlot][area]) return null;
  let sortedLocs = Object.keys(grid[day][startSlot][area]).sort((a,b) => (parseInt(a.replace(/\D/g, ''))||0) - (parseInt(b.replace(/\D/g, ''))||0));
  let freeLocs = [];
  for(let loc of sortedLocs) {
      if (loc === excludeLoc) continue;
      let isFree = true;
      for (let s = startSlot; s < startSlot + slotsNeeded; s++) { if (grid[day][s][area][loc] !== null) { isFree = false; break; } }
      if (isFree) freeLocs.push(loc);
      if (freeLocs.length === 2) return { loc: freeLocs[0], loc2: freeLocs[1], area: area };
  }
  return null;
}

// ---------------- DATA NORMALIZATION ----------------
function standardizeTasks(rawData, config) {
  let rawParsed = [];
  let lastFac = "Unknown Faculty"; 

  rawData.forEach(row => {
    let newRow = {};
    for (let key in row) newRow[key.toString().trim().toLowerCase()] = row[key];
    newRow._dept = row._dept; 
    let semClean = (newRow["semester"] || "").toString().replace(/[^0-9]/g, '');
    let secRaw = (newRow["section"] || newRow["section (if applicable)"] || "").toString().trim().toUpperCase();
    
    let baseSec = secRaw;
    let subgroup = 'ALL';

    let match = secRaw.match(/^(.*?)(1|2)$/); 
    if (match) {
        baseSec = match[1].replace(/[^A-Z0-9]/g, '').trim();
        subgroup = match[2] === '1' ? 'G1' : 'G2';
    } else if (secRaw.includes('G1') && !secRaw.includes('G2')) {
        baseSec = secRaw.replace('G1', '').replace(/[^A-Z0-9]/g, '').trim();
        subgroup = 'G1';
    } else if (secRaw.includes('G2') && !secRaw.includes('G1')) {
        baseSec = secRaw.replace('G2', '').replace(/[^A-Z0-9]/g, '').trim();
        subgroup = 'G2';
    } else {
        baseSec = secRaw.replace(/G1|G2/g, '').replace(/[^A-Z0-9]/g, '').trim();
        subgroup = 'ALL';
    }
    if (!baseSec) baseSec = "A";

    let rawBranch = (newRow["branch"] || "").toString().trim().toUpperCase();
    let branches = [];
    if (rawBranch.includes('EE & ETE') || rawBranch.includes('EE/ETE') || rawBranch.includes('EE&ETE')) {
        branches = ['EE', 'ETE'];
    } else {
        branches = [rawBranch];
    }
    
    let batchIds = branches.map(br => `[${newRow._dept}] ${br}-${semClean}-${baseSec}`);

    let facIdRaw = (newRow["faculty id"] || newRow["faculty code"] || newRow["emp code"] || "").toString().trim();
    let facNameRaw = (newRow["name of faculty"] || newRow["faculty name"] || newRow["faculty"] || "").toString().trim();
    
    let itemFaculties = parseMultipleFaculties(facIdRaw, facNameRaw);
    let displayFacultyStr = itemFaculties.join(' / ');
    if (!facNameRaw) displayFacultyStr = lastFac; else lastFac = displayFacultyStr;
    if (itemFaculties.length === 1 && itemFaculties[0] === "Unknown Faculty") {
        itemFaculties = parseMultipleFaculties("", lastFac);
    }
    
    let sub = newRow["name of subject"] || newRow["subject"] || null;
    if (!sub) return;
    
    let L = parseInt(newRow["l"]) || 0; let T = parseInt(newRow["t"]) || parseInt(newRow["tutorial"]) || 0; let P = parseInt(newRow["p"]) || 0;
    
    let theorySessions = L + T;
    for (let l = 0; l < theorySessions; l++) { 
        rawParsed.push({ type: 'Theory', dept: newRow._dept, faculty: displayFacultyStr, faculties: itemFaculties, subject: sub, batch: batchIds, subgroup: 'ALL', sem: semClean, sessionIndex: l }); 
    }
    if (P > 0) {
        let labSessions = Math.floor(P / 2) || 1; 
        let isDELab = (sub.toLowerCase().includes('de lab') || sub.toLowerCase().includes('digital electronics'));
        
        for (let i = 0; i < labSessions; i++) {
            // Force split DE Labs into group-wise logic even if they were passed as 'ALL' in Excel
            if (isDELab && newRow._dept === 'CSE' && subgroup === 'ALL') {
                rawParsed.push({ type: 'Lab', dept: newRow._dept, faculty: displayFacultyStr, faculties: itemFaculties, subject: sub, batch: batchIds, subgroup: 'G1', sem: semClean, sessionIndex: i }); 
                rawParsed.push({ type: 'Lab', dept: newRow._dept, faculty: displayFacultyStr, faculties: itemFaculties, subject: sub, batch: batchIds, subgroup: 'G2', sem: semClean, sessionIndex: i }); 
            } else {
                rawParsed.push({ type: 'Lab', dept: newRow._dept, faculty: displayFacultyStr, faculties: itemFaculties, subject: sub, batch: batchIds, subgroup: subgroup, sem: semClean, sessionIndex: i }); 
            }
        }
    }
  });

  let theoryMerged = [];
  rawParsed.filter(t => t.type === 'Theory').forEach(task => {
      let existingMatch = theoryMerged.find(t => 
          t.faculty === task.faculty && 
          t.subject === task.subject && 
          t.sessionIndex === task.sessionIndex && 
          (task.dept === 'EE' || task.dept === 'ETE' || task.dept === 'COMBINED-EE/ETE') && 
          (t.dept === 'EE' || t.dept === 'ETE' || t.dept === 'COMBINED-EE/ETE')
      );
      if (existingMatch) {
          task.batch.forEach(b => { if(!existingMatch.batch.includes(b)) existingMatch.batch.push(b); });
          existingMatch.dept = "COMBINED-EE/ETE";
      } else theoryMerged.push(task);
  });

  let processedLabs = [];
  let rawLabs = rawParsed.filter(t => t.type === 'Lab');
  let labPairsMap = {}; 
  
  rawLabs.forEach(lab => {
      let batchKey = [...lab.batch].sort().join(",");
      let key = `${lab.subject}_${batchKey}`; 
      if(!labPairsMap[key]) labPairsMap[key] = { G1: [], G2: [], ALL: [] };
      labPairsMap[key][lab.subgroup].push(lab);
  });

  for(let key in labPairsMap) {
      let pair = labPairsMap[key];
      let sample = pair.G1[0] || pair.G2[0] || pair.ALL[0];
      if (!sample) continue;
      
      let isPhysChem = sample.subject.toLowerCase().includes('physics') || sample.subject.toLowerCase().includes('chem');
      
      if (isPhysChem) {
          while(pair.G1.length > 0 || pair.G2.length > 0 || pair.ALL.length > 0) {
              let g1 = pair.G1.pop();
              let g2 = pair.G2.pop();
              let all = pair.ALL.pop();
              
              let gatheredFacs = [];
              if(g1) gatheredFacs.push(...g1.faculties);
              if(g2) gatheredFacs.push(...g2.faculties);
              if(all) gatheredFacs.push(...all.faculties);
              
              gatheredFacs = [...new Set(gatheredFacs)];
              let currentSample = g1 || g2 || all;
              
              let f1 = gatheredFacs[0] || currentSample.faculty;
              let f2 = gatheredFacs[1] || f1;
              
              processedLabs.push({ 
                  type: 'LabCoTeach', dept: currentSample.dept, 
                  faculty: gatheredFacs.join(' / '), faculties: gatheredFacs,
                  facultyG1: f1, facultyG2: f2, 
                  subject: currentSample.subject, batch: currentSample.batch, subgroup: 'ALL', sem: currentSample.sem 
              });
          }
      } else {
          while(pair.G1.length > 0) {
              let g1 = pair.G1.pop();
              let g2 = pair.G2.length > 0 ? pair.G2.pop() : null;
              
              if(g2) {
                  let isDELab = (g1.subject.toLowerCase().includes('de lab') || g1.subject.toLowerCase().includes('digital electronics')) && g1.dept === 'CSE';
                  
                  if (g1.faculty === g2.faculty && !isDELab) {
                      g1.subgroup = 'ALL'; processedLabs.push(g1);
                  } else if (g1.faculty !== g2.faculty) {
                      processedLabs.push({ type: 'LabSplit', dept: g1.dept, facultyG1: g1.faculty, facultyG2: g2.faculty, faculties: [...new Set([...g1.faculties, ...g2.faculties])], subject: g1.subject, batch: g1.batch, subgroup: 'ALL', sem: g1.sem });
                  } else {
                      // Same faculty BUT it's a DE Lab -> Do not merge into 'ALL'. Keep separate for true group-wise scheduling.
                      processedLabs.push(g1);
                      processedLabs.push(g2);
                  }
              } else processedLabs.push(g1); 
          }
          pair.G2.forEach(l => processedLabs.push(l));
          pair.ALL.forEach(l => processedLabs.push(l));
      }
  }

  return [...theoryMerged, ...processedLabs];
}

function initializeGrid(days, slots, config) {
  let grid = {};
  days.forEach(day => {
    grid[day] = [];
    for(let i=0; i<slots; i++) {
      let bStates = {};
      config.batches.forEach(b => { bStates[b] = { ALL: null, G1: null, G2: null }; });
      grid[day].push({
        asRooms: config.asRooms.reduce((a, v) => ({ ...a, [v]: null}), {}),
        asCompHalf: config.asCompHalf.reduce((a, v) => ({ ...a, [v]: null}), {}),
        asPhysicsFull: config.asPhysicsFull.reduce((a, v) => ({ ...a, [v]: null}), {}),
        asChemFull: config.asChemFull.reduce((a, v) => ({ ...a, [v]: null}), {}),
        
        cseRooms: config.cseRooms.reduce((a, v) => ({ ...a, [v]: null}), {}),
        cseCompHalf: config.cseCompHalf.reduce((a, v) => ({ ...a, [v]: null}), {}),
        cseCompFull: config.cseCompFull.reduce((a, v) => ({ ...a, [v]: null}), {}),
        cseElecHalf: config.cseElecHalf.reduce((a, v) => ({ ...a, [v]: null}), {}),

        eteElec: config.eteElec.reduce((a, v) => ({ ...a, [v]: null}), {}),
        
        batches: bStates
      });
    }
  });
  return grid;
}

function initializeFacultyTracker(tasks, days) {
  let tracker = {};
  tasks.forEach(item => {
    let facs = getFaculties(item);
    facs.forEach(f => { if(f && !tracker[f]) { tracker[f] = {}; days.forEach(d => { tracker[f][d] = { totalDailyLoad: 0, slots: new Array(9).fill(null) }; }); } });
  });
  return tracker;
}

// ---------------- DRIVE SAVE & LOAD ----------------
function saveScheduleToDrive(data) {
  try {
    let files = DriveApp.getFilesByName("SmartTimetablePro_Unified.json");
    if (files.hasNext()) files.next().setContent(JSON.stringify(data)); 
    else DriveApp.createFile("SmartTimetablePro_Unified.json", JSON.stringify(data), MimeType.PLAIN_TEXT);
    return { success: true, message: "Timetable saved to Drive successfully!" };
  } catch(e) { return { success: false, message: "Failed to save: " + e.toString() }; }
}

function loadScheduleFromDrive() {
  try {
    let files = DriveApp.getFilesByName("SmartTimetablePro_Unified.json");
    if (files.hasNext()) return { success: true, data: JSON.parse(files.next().getBlob().getDataAsString()), message: "Restored successfully!" };
    return { success: false, message: "No backup file found." };
  } catch(e) { return { success: false, message: "Failed to load: " + e.toString() }; }
}
